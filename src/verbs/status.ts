import { FgjError } from "../core/errors.ts";
import type { ParsedArgs, ReadVerb } from "../core/verb.ts";
import type { ReadApi } from "../forgejo/client.ts";
import type { Target } from "../forgejo/target.ts";
import { branchPath, REPO_FLAG } from "./common.ts";
import { jobOf, runFailure, runOf } from "./run.ts";
import { pollUntil, secondsSince, WAIT_TIMES } from "./wait.ts";

/** A commit status, reduced to the keys fgj reads. */
interface ApiStatus {
	status: string;
	context: string;
	description: string | null;
	target_url: string | null;
	created_at?: string;
}

/** The state of a commit's checks, after Forgejo's rule. `none`: no check reported. */
export type ChecksState =
	| "failure"
	| "warning"
	| "pending"
	| "success"
	| "skipped"
	| "none";

/** The key of the job index that a check links to, for a wait. It never prints. */
export const CHECK_JOB: unique symbol = Symbol("checkJob");

/** One check, as fgj shows it. */
export interface Check {
	[CHECK_JOB]?: number;
	context: string;
	state: string;
	description?: string;
	/** The web run number, when the check links to an Actions run of the repository. */
	run?: number;
	/** The check's link, when it is not an Actions run of the repository. */
	url?: string;
}

/**
 * The key of the time the oldest pending check started, for a wait. A symbol
 * key never prints, so `status get` output stays the same.
 */
export const PENDING_SINCE: unique symbol = Symbol("pendingSince");

/** The checks of one commit. */
export interface Checks {
	[PENDING_SINCE]?: string;
	state: ChecksState;
	total: number;
	checks: Check[];
	/** The check patterns that the base branch needs, when fgj knows the base. */
	required?: string[];
	/** The required patterns that no check matches. */
	missing?: string[];
}

/** Check states that do not change any more. */
const FINAL = new Set(["success", "failure", "error", "warning", "skipped"]);

/** Forgejo's page size limit for the combined status. */
const STATUS_PAGE = 50;

/** The most status pages fgj reads for one commit. */
const STATUS_PAGES_MAX = 20;

/**
 * Combines check states as Forgejo 16 does: `error` or `failure` gives
 * failure; otherwise warning beats pending, pending beats success, and success
 * beats skipped. A state that Forgejo does not define counts as pending.
 *
 * @param states - The state of each check.
 * @returns The combined state, or `none` for no state.
 * @example
 * combineStates(["success", "error"]); // "failure"
 */
export function combineStates(states: readonly string[]): ChecksState {
	if (states.length === 0) return "none";
	const order = [
		"failure",
		"warning",
		"pending",
		"success",
		"skipped",
	] as const;
	const rank = (s: string) =>
		s === "error"
			? 0
			: order.includes(s as (typeof order)[number])
				? order.indexOf(s as (typeof order)[number])
				: 2;
	return order[Math.min(...states.map(rank))] as ChecksState;
}

/**
 * Matches a required check pattern of a branch protection. fgj reads `*` (any
 * text, `/` included) and `?` (one character). A pattern with other glob
 * syntax that Forgejo reads (`\`, `[`, `]`, `{`, `}`) never matches: fgj shows
 * it as missing, which can be stricter than the server, never a false pass.
 *
 * @param pattern - The pattern, for example `Verify / *`.
 * @param context - The check's context.
 * @returns True when the context matches.
 * @example
 * patternMatches("ci/*", "ci/lint"); // true
 */
export function patternMatches(pattern: string, context: string): boolean {
	return matcher(pattern)(context);
}

/**
 * Builds a matcher for one pattern, so a pattern is read once for many
 * checks. Matching keeps one backtrack point per star: O(n·m), never a hang.
 *
 * @param pattern - The pattern, for example `Verify / *`.
 * @returns A function that tells whether a context matches.
 * @example
 * matcher("ci/*")("ci/lint"); // true
 */
export function matcher(pattern: string): (context: string) => boolean {
	// fgj cannot read this syntax as Forgejo does; a missing check is safe.
	if (/[\\[\]{}]/.test(pattern)) return () => false;
	// Code points, so ? is one character, an emoji too. Repeated stars are one.
	const tokens = Array.from(pattern).filter(
		(c, i, all) => !(c === "*" && all[i - 1] === "*"),
	);
	return (context) => {
		const text = Array.from(context);
		let t = 0;
		let s = 0;
		let star = -1;
		let mark = 0;
		while (s < text.length) {
			const token = tokens[t];
			if (
				token !== undefined &&
				token !== "*" &&
				(token === "?" || token === text[s])
			) {
				t++;
				s++;
			} else if (token === "*") {
				star = t++;
				mark = s;
			} else if (star >= 0) {
				t = star + 1;
				s = ++mark;
			} else return false;
		}
		while (tokens[t] === "*") t++;
		return t === tokens.length;
	};
}

/**
 * Reads the check patterns that a branch protection needs before a merge.
 *
 * @param api - A client that can GET.
 * @param target - The repository.
 * @param branch - The base branch.
 * @returns The patterns, or an empty list when the branch needs no check.
 * @throws {FgjError} not_found, naming the branch, when it does not exist.
 * @example
 * await requiredChecks(api, target, "main"); // ["Verify / verify (pull_request)"]
 */
export async function requiredChecks(
	api: Pick<ReadApi, "get">,
	target: Target,
	branch: string,
): Promise<string[]> {
	let rules: {
		enable_status_check?: boolean;
		status_check_contexts?: string[] | null;
	};
	try {
		rules = await api.get(branchPath(target, branch));
	} catch (err) {
		if (err instanceof FgjError && err.code === "not_found") {
			throw new FgjError(
				"not_found",
				`The base branch ${branch} does not exist in ${target.owner}/${target.name}, so fgj cannot read its required checks.`,
				err.hint,
			);
		}
		throw err;
	}
	return rules.enable_status_check ? (rules.status_check_contexts ?? []) : [];
}

/**
 * Reads every check of a commit, page by page, and computes the state itself:
 * Forgejo's combined state covers only one page. A required pattern that no
 * check matches counts as pending, as the server treats it.
 *
 * @param api - A client that can GET.
 * @param target - The repository.
 * @param sha - The full commit SHA.
 * @param required - The required patterns of the base branch, when known.
 * @returns The state, the number of checks, the checks, and the required and missing patterns.
 * @example
 * const { state } = await readChecks(api, target, sha, ["ci/*"]);
 */
export async function readChecks(
	api: Pick<ReadApi, "getCounted">,
	target: Target,
	sha: string,
	required?: readonly string[],
): Promise<Checks> {
	const path = `/repos/${target.owner}/${target.name}/commits/${sha}/status`;
	const statuses: ApiStatus[] = [];
	for (let page = 1; ; page++) {
		// X-Total-Count counts every check; the body counts only this page. A
		// server can page below 50, so a short page does not mean the end.
		// Forgejo sends no count for a commit with no checks.
		const got = await api.getCounted<{ statuses: ApiStatus[] | null }>(path, {
			page,
			limit: STATUS_PAGE,
		});
		const items = got.data.statuses ?? [];
		statuses.push(...items);
		// With no count, read on until a page comes back empty.
		if (
			items.length === 0 ||
			(got.total !== undefined && statuses.length >= got.total)
		) {
			break;
		}
		if (page === STATUS_PAGES_MAX) {
			throw new FgjError(
				"api",
				`The commit ${sha} has more than ${STATUS_PAGE * STATUS_PAGES_MAX} checks; fgj reads at most that many, so it cannot tell the state.`,
				"fgj help status get",
			);
		}
	}
	const checks = statuses.map((s): Check => {
		const run = s.target_url ? runOf(s.target_url, target) : undefined;
		const url =
			run === undefined && s.target_url
				? safeUrl(s.target_url, target.baseUrl)
				: undefined;
		const job = run === undefined ? undefined : jobOf(s.target_url ?? "");
		return {
			...(job === undefined ? {} : { [CHECK_JOB]: job }),
			context: s.context,
			state: s.status,
			...(s.description ? { description: s.description } : {}),
			...(run === undefined ? {} : { run }),
			...(url === undefined ? {} : { url }),
		};
	});
	const missing = (required ?? []).filter((p) => {
		const matches = matcher(p);
		return !checks.some((c) => matches(c.context));
	});
	const oldest = statuses
		.filter((s) => !FINAL.has(s.status) && s.created_at)
		.map((s) => s.created_at as string)
		.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
	return {
		...(oldest ? { [PENDING_SINCE]: oldest } : {}),
		state: combineStates([
			...checks.map((c) => c.state),
			...(missing.length > 0 ? ["pending"] : []),
		]),
		total: checks.length,
		checks,
		...(required && required.length > 0
			? { required: [...required], missing }
			: {}),
	};
}

/**
 * Makes a status link absolute, for http and https only, and drops a user and
 * password in it. Any user who can post a status sets the link.
 */
function safeUrl(link: string, baseUrl: string): string | undefined {
	let url: URL;
	try {
		url = new URL(link, `${baseUrl}/`);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	url.username = "";
	url.password = "";
	return url.href;
}

interface StatusInput {
	ref?: string;
	pr?: number;
}

/** Finds the commit that the input names, and its base's required checks for --pr. */
async function commitOf(
	api: Pick<ReadApi, "get">,
	target: Target,
	input: StatusInput,
	hint: string,
): Promise<{ sha: string; required?: string[] }> {
	const slug = `${target.owner}/${target.name}`;
	const repoPath = `/repos/${slug}`;
	let sha: string;
	let required: string[] | undefined;
	if (input.pr !== undefined) {
		let pull: { head: { sha: string }; base: { ref: string } };
		try {
			pull = await api.get(`${repoPath}/pulls/${input.pr}`);
		} catch (err) {
			if (err instanceof FgjError && err.code === "not_found") {
				throw new FgjError(
					"not_found",
					`No pull request ${input.pr} in ${slug}.`,
					hint,
				);
			}
			throw err;
		}
		sha = pull.head.sha;
		required = await requiredChecks(api, target, pull.base.ref);
	} else {
		// Forgejo answers an empty 200 for checks of a ref that does not
		// exist, so resolve it first. The query form takes a branch with /.
		let found: { sha: string }[];
		try {
			found = await api.get(`${repoPath}/commits`, {
				sha: input.ref as string,
				limit: 1,
				page: 1,
				stat: "false",
				verification: "false",
				files: "false",
			});
		} catch (err) {
			if (err instanceof FgjError && err.code === "not_found") {
				throw new FgjError(
					"not_found",
					`No commit, branch, or tag "${input.ref}" in ${slug}.`,
					hint,
				);
			}
			throw err;
		}
		const first = found[0];
		if (!first) {
			throw new FgjError(
				"not_found",
				`No commit, branch, or tag "${input.ref}" in ${slug}.`,
				hint,
			);
		}
		sha = first.sha;
	}
	return { sha, ...(required ? { required } : {}) };
}

/** Reads the commit that a status verb names: one ref, or --pr N. */
function statusInput(args: ParsedArgs, hint: string): StatusInput {
	const pr = args.flags.pr;
	if ((args.positionals.length === 0) === (pr === undefined)) {
		throw new FgjError(
			"usage",
			"Name one commit: a SHA, a branch, or a tag, or --pr N.",
			hint,
		);
	}
	if (args.positionals.length > 1) {
		throw new FgjError(
			"usage",
			`Expected one ref, got ${args.positionals.length}: ${args.positionals.join(" ")}.`,
			hint,
		);
	}
	if (pr !== undefined) {
		if (Number(pr) < 1) {
			throw new FgjError("usage", "--pr needs a PR number above 0.", hint);
		}
		return { pr: Number(pr) };
	}
	const ref = args.positionals[0] as string;
	if (ref.startsWith("-") || /[\s~^:?*[\\]/.test(ref) || ref.includes("..")) {
		throw new FgjError(
			"usage",
			`"${ref}" is not a commit SHA, a branch, or a tag.`,
			hint,
		);
	}
	return { ref };
}

/** `fgj read status get <ref> | --pr N`: the checks of one commit. */
export const statusGet: ReadVerb<StatusInput> = {
	risk: "read",
	noun: "status",
	action: "get",
	summary:
		"Read the checks of a commit: the state, and one entry per check with its Actions run.",
	notes: [
		"state is failure, warning, pending, success, skipped, or none. skipped means that every check was skipped. none means that no check reported: it is not a pass.",
		"fgj computes state from every check with Forgejo's rule: any error or failure gives failure; otherwise warning beats pending, pending beats success, and success beats skipped.",
		"With --pr, fgj also reads the checks that the base branch needs. missing lists the required patterns that no check matches, and a missing check makes the state pending. fgj reads * and ? in a pattern; a pattern with other glob syntax always shows as missing.",
		"run is the Actions run number: read it with fgj read run get N. On a failure, the hint reads the first failed run. On pending, the hint is the same call: run it again later.",
	],
	args: [
		{
			name: "ref",
			description:
				"A commit SHA (7 to 40 hex digits), a branch, or a tag. Leave it out with --pr.",
		},
	],
	flags: [
		{
			name: "pr",
			kind: "int",
			description:
				"The head commit of this pull request, with its base branch's required checks.",
		},
		REPO_FLAG,
	],
	output:
		"{sha, state, total, checks:[{context, state, description, run}], required, missing, note, hint}. required and missing only with --pr on a protected base. description only when set. A check with no Actions run has url instead of run. note only for none; hint only for a failure or pending.",
	examples: ["fgj read status get --pr 42", "fgj read status get 3f2c1b0"],
	prepare(args: ParsedArgs): StatusInput {
		return statusInput(args, "fgj help status get");
	},
	async run(input, { target, api, commandWith, commandFor }) {
		const hint = "fgj help status get";
		const { sha, required } = await commitOf(api, target, input, hint);
		const checks = await readChecks(api, target, sha, required);
		const failed = checks.checks.find(
			(c) =>
				(c.state === "failure" || c.state === "error") && c.run !== undefined,
		);
		return {
			sha,
			...checks,
			...(checks.state === "none" ? { note: NONE_NOTE } : {}),
			...(failed?.run !== undefined
				? { hint: commandFor("read run get", [String(failed.run)]) }
				: checks.state === "pending"
					? { hint: commandWith({}) }
					: {}),
		};
	},
};

/** The note for a commit with no check. */
const NONE_NOTE =
	"No check reported for this commit. none is not a pass: no check ran, or none has started yet.";

/** `fgj read status wait <ref> | --pr N`: wait for the checks of one commit. */
export const statusWait: ReadVerb<StatusInput> = {
	risk: "read",
	noun: "status",
	action: "wait",
	summary: "Wait up to 90 s for a commit's checks; pending gives next.",
	notes: [
		"It ends when every check has finished, or at the first failed check, even while others still run; still_pending counts those. While a check runs, state is pending.",
		"A failure adds failure: {context, run, job, lines}, the error lines of that check's Actions run, as run get shows them. A check with no Actions run gives its url instead.",
		"With no check, it looks again up to 20 s, then ends as none. none is not a pass: no check ran.",
		"One call waits at most 90 s. Checks that have not finished by then return pending with next: run that command to wait more. pending_s is how long the oldest pending check has waited.",
		"With --pr, a required check that no check matches keeps the wait pending, as status get counts it.",
	],
	args: statusGet.args,
	flags: statusGet.flags,
	output:
		"{sha, state, total, checks, required, missing} as status get; failure and still_pending for a failure, note for none, pending_s and next for pending.",
	examples: ["fgj read status wait --pr 42", "fgj read status wait 3f2c1b0"],
	prepare(args: ParsedArgs): StatusInput {
		return statusInput(args, "fgj help status wait");
	},
	async run(input, ctx) {
		const hint = "fgj help status wait";
		const { target, api } = ctx;
		const times = ctx.waitTimes ?? WAIT_TIMES;
		// The 90 s count from here, so the lookup counts too.
		const start = Date.now();
		const { sha, required } = await commitOf(api, target, input, hint);
		/** Checks that can still change: not final, or required and missing. */
		const running = (checks: Checks) =>
			checks.checks.filter((c) => !FINAL.has(c.state)).length +
			(checks.missing?.length ?? 0);
		const last = await pollUntil(
			times,
			async (elapsed) => {
				const checks = await readChecks(api, target, sha, required);
				const done =
					checks.state === "failure" ||
					(checks.state === "none"
						? elapsed >= times.grace
						: running(checks) === 0);
				return { done, value: checks };
			},
			start,
		);
		const checks = last.value;
		// Forgejo ranks warning over pending, but a wait is not done while a check runs.
		const out: Record<string, unknown> = {
			sha,
			...checks,
			...(last.done ? {} : { state: "pending" }),
		};
		if (checks.state === "none" && last.done) out.note = NONE_NOTE;
		if (checks.state === "failure") {
			const failed = checks.checks.find(
				(c) => c.state === "failure" || c.state === "error",
			);
			if (failed) {
				const block =
					failed.run === undefined
						? undefined
						: await runFailure(ctx, failed.run, failed[CHECK_JOB]);
				out.failure = {
					context: failed.context,
					...(failed.run === undefined ? {} : { run: failed.run }),
					...(failed.url === undefined ? {} : { url: failed.url }),
					...(block ?? {}),
				};
			}
			const still = running(checks);
			if (still > 0) out.still_pending = still;
		}
		if (!last.done) {
			const waited = secondsSince(checks[PENDING_SINCE], Date.now());
			if (waited !== undefined) out.pending_s = waited;
			out.next = ctx.commandWith({});
		}
		return out;
	},
};

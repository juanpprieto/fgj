import { FgjError } from "../core/errors.ts";
import { OUTPUT_CAP } from "../core/output.ts";
import type {
	FlagSpec,
	ParsedArgs,
	ReadVerb,
	VerbContext,
	WriteVerb,
} from "../core/verb.ts";
import {
	cleanLog,
	errorBlock,
	jobResult,
	matchLines,
} from "../forgejo/actions.ts";
import type { ReadApi } from "../forgejo/client.ts";
import { parseRemote, type Remote, type Target } from "../forgejo/target.ts";
import { DRY_RUN_FLAG, REPO_FLAG } from "./common.ts";
import { pollUntil, secondsSince, WAIT_TIMES } from "./wait.ts";

/** A Forgejo Actions run, reduced to the keys that fgj reads. */
interface ApiRun {
	id: number;
	index_in_repo: number;
	status: string;
	event: string;
	prettyref: string;
	commit_sha: string;
	title: string;
	html_url: string;
	/** When Forgejo created the run, last changed it (a re-run does), and started its latest attempt. */
	created?: string;
	updated?: string;
	started?: string;
}

/** A job of a run. `task_id` is 0 for a job that never ran. */
interface ApiJob {
	id: number;
	name: string;
	status: string;
	task_id: number;
	attempt: number;
	/** The YAML keys of the jobs that this job needs. A `name:` hides a job's own key. */
	needs?: string[] | null;
}

/** How the caller names the run. */
type RunRef =
	| {
			kind: "number";
			number: number;
			job?: number;
			attempt?: number;
			remote?: Remote;
			slug?: string;
			/** The run URL without its job or attempt, for hints that must name the same run. */
			url?: string;
	  }
	| { kind: "pr"; pr: number }
	| { kind: "commit"; sha: string };

/**
 * The run URL form: `…/owner/repo/actions/runs/40`, with an optional
 * `/jobs/N` and `/attempt/M`. The browser shows `/attempt/M`, because Forgejo
 * redirects a job URL to its latest attempt.
 */
const RUN_URL =
	/^(?:(https?:\/\/.+?))?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/([1-9]\d{0,14})(?:\/jobs\/(\d{1,4})(?:\/attempt\/([1-9]\d{0,3}))?)?\/?(?:[?#].*)?$/;

const RUN_FLAGS: FlagSpec[] = [
	{
		name: "pr",
		kind: "int",
		description:
			"The latest run of this pull request, instead of a run number.",
	},
	{
		name: "commit",
		kind: "string",
		value: "SHA",
		description:
			"The latest run of this commit (7 to 40 hex digits), instead of a run number.",
	},
];

const RUN_ARG = {
	name: "run",
	description:
		"The run number from the web UI (40), a run URL, or a commit status target_url (/owner/repo/actions/runs/40/jobs/0). Leave it out with --pr or --commit.",
};

const RUN_NOTES = [
	"The run number is the one in the web UI and in a commit status target_url. fgj finds the API ids itself; they differ from the run number.",
	"A job that never ran, or a log that expired, reads as `unavailable` with Forgejo's reason. A job that has not run yet, and a running run, carry the hint to read the run again later; an expired log has no remedy.",
];

/**
 * Reads the web run number from a commit status `target_url`, when the URL
 * names an Actions run of the target repository.
 *
 * @param url - The target_url, relative (`/o/r/actions/runs/53/jobs/0`) or absolute.
 * @param target - The repository that the status belongs to.
 * @returns The run number, or `undefined` for any other URL.
 * @example
 * runOf("/o/r/actions/runs/53/jobs/0", target); // 53 when target is o/r
 */
export function runOf(url: string, target: Target): number | undefined {
	const match = RUN_URL.exec(url);
	if (!match) return undefined;
	const [, base, owner, name, number] = match as unknown as string[];
	const same =
		`${owner}/${name}`.toLowerCase() ===
			`${target.owner}/${target.name}`.toLowerCase() &&
		(base === undefined || base.toLowerCase() === target.baseUrl.toLowerCase());
	return same ? Number(number) : undefined;
}

/**
 * Reads the 0-based job index from a run URL that names a job, such as a
 * commit status target_url.
 *
 * @param url - The URL, relative or absolute.
 * @returns The job index, or undefined when the URL names no job.
 * @example
 * jobOf("/o/r/actions/runs/53/jobs/1"); // 1
 */
export function jobOf(url: string): number | undefined {
	const job = RUN_URL.exec(url)?.[5];
	return job === undefined ? undefined : Number(job);
}

/** Reads the run argument and flags. Exactly one way to name the run. */
function runRef(args: ParsedArgs, hint: string): RunRef {
	const pr = args.flags.pr;
	const commit = args.flags.commit;
	const given = [
		args.positionals.length > 0,
		pr !== undefined,
		commit !== undefined,
	];
	if (given.filter(Boolean).length !== 1 || args.positionals.length > 1) {
		throw new FgjError(
			"usage",
			"Name one run: a run number, a run URL, --pr N, or --commit SHA.",
			hint,
		);
	}
	if (pr !== undefined) return { kind: "pr", pr: Number(pr) };
	if (commit !== undefined) {
		const sha = String(commit).toLowerCase();
		if (!/^[0-9a-f]{7,40}$/.test(sha)) {
			throw new FgjError(
				"usage",
				`--commit needs 7 to 40 hex digits, got "${commit}".`,
				hint,
			);
		}
		return { kind: "commit", sha };
	}
	const raw = args.positionals[0] as string;
	const plain = /^#?([1-9]\d{0,14})$/.exec(raw);
	if (plain) return { kind: "number", number: Number(plain[1]) };
	const url = RUN_URL.exec(raw);
	if (url) {
		const [, base, owner, name, number, job, attempt] =
			url as unknown as string[];
		const remote = base ? parseRemote(`${base}/${owner}/${name}`) : null;
		return {
			kind: "number",
			number: Number(number),
			...(job === undefined ? {} : { job: Number(job) }),
			...(attempt === undefined ? {} : { attempt: Number(attempt) }),
			...(remote ? { remote } : { slug: `${owner}/${name}` }),
			url: `${base ?? ""}/${owner}/${name}/actions/runs/${number}`,
		};
	}
	throw new FgjError(
		"usage",
		`Expected a run number or a run URL, got "${raw}".`,
		hint,
	);
}

/** The latest run that a list query finds. `page=1` makes Forgejo apply `limit`. */
async function firstRun(
	api: Pick<ReadApi, "get">,
	repoPath: string,
	filter: Record<string, string | number>,
): Promise<ApiRun | undefined> {
	const out = await api.get<{ workflow_runs: ApiRun[] | null }>(
		`${repoPath}/actions/runs`,
		{ ...filter, page: 1, limit: 1 },
	);
	return out.workflow_runs?.[0];
}

/** Finds the run and its jobs, with the read or the write client. */
async function resolveRun(
	ctx: Pick<VerbContext<Pick<ReadApi, "get">>, "target" | "api">,
	ref: RunRef,
	hint: string,
): Promise<{ run: ApiRun; jobs: ApiJob[] }> {
	const { owner, name } = ctx.target;
	const slug = `${owner}/${name}`;
	const repoPath = `/repos/${owner}/${name}`;
	let run: ApiRun | undefined;
	let what: string;
	if (ref.kind === "number") {
		if (ref.slug && ref.slug.toLowerCase() !== slug.toLowerCase()) {
			throw new FgjError(
				"usage",
				`The path names ${ref.slug}, but the repository is ${slug}. Add --repo ${ref.slug}.`,
				hint,
			);
		}
		what = `run ${ref.number}`;
		run = await firstRun(ctx.api, repoPath, { run_number: ref.number });
	} else if (ref.kind === "commit") {
		what = `a run of commit ${ref.sha}`;
		let sha = ref.sha;
		if (sha.length < 40) {
			try {
				sha = (
					await ctx.api.get<{ sha: string }>(`${repoPath}/git/commits/${sha}`)
				).sha;
			} catch (err) {
				if (err instanceof FgjError && err.code === "not_found") {
					throw new FgjError(
						"not_found",
						`No commit ${ref.sha} in ${slug}.`,
						hint,
					);
				}
				throw err;
			}
		}
		run = await firstRun(ctx.api, repoPath, { head_sha: sha });
	} else {
		what = `a run of pull request ${ref.pr}`;
		run = await firstRun(ctx.api, repoPath, {
			ref: `refs/pull/${ref.pr}/head`,
		});
		if (!run) {
			// A push to the PR branch runs on the branch, not on the PR ref.
			const pull = await ctx.api
				.get<{ head: { sha: string } }>(`${repoPath}/pulls/${ref.pr}`)
				.catch((err: unknown) => {
					if (err instanceof FgjError && err.code === "not_found") {
						throw new FgjError(
							"not_found",
							`No pull request ${ref.pr} in ${slug}.`,
							hint,
						);
					}
					throw err;
				});
			run = await firstRun(ctx.api, repoPath, { head_sha: pull.head.sha });
		}
	}
	if (!run) {
		throw new FgjError("not_found", `No Actions ${what} in ${slug}.`, hint);
	}
	const jobs =
		(await ctx.api.get<ApiJob[] | null>(
			`${repoPath}/actions/runs/${run.id}/jobs`,
		)) ?? [];
	return { run, jobs };
}

/** Reads a job's log, or the reason Forgejo gives when it has none. */
async function readLog(
	ctx: VerbContext<ReadApi>,
	job: ApiJob,
	attempt?: number,
): Promise<{ lines: string[] } | { unavailable: string }> {
	const { owner, name } = ctx.target;
	try {
		const text = await ctx.api.getText(
			`/repos/${owner}/${name}/actions/jobs/${job.id}/logs`,
			attempt === undefined ? undefined : { attempt },
		);
		return { lines: cleanLog(text) };
	} catch (err) {
		if (err instanceof FgjError && err.code === "not_found") {
			// Forgejo names the reason: never executed, or expired.
			const reason =
				/\) GET [^:]+: (.*)$/.exec(err.message)?.[1] ?? err.message;
			return { unavailable: reason };
		}
		throw err;
	}
}

/** The failure block of one job: its error lines, cut to fit, or why it has no log. */
async function failureOf(
	ctx: VerbContext<ReadApi>,
	out: Record<string, unknown>,
	job: ApiJob,
	attempt?: number,
): Promise<
	{ job: string; lines: string[] } | { job: string; unavailable: string }
> {
	const log = await readLog(ctx, job, attempt);
	if ("unavailable" in log)
		return { job: job.name, unavailable: log.unavailable };
	return {
		job: job.name,
		lines: fitLines(out, errorBlock(log.lines), true).lines,
	};
}

/**
 * The failure block of a run, for a check that links to it: the job that the
 * check names, else the first failed job, else the first job.
 *
 * @param ctx - The verb context.
 * @param number - The web run number.
 * @param jobIndex - The 0-based job that the check links to, when it names one.
 * @returns The block, or undefined when the run has no jobs or is gone.
 * @example
 * await runFailure(ctx, 40); // { job: "verify", lines: ["Error: …"] }
 */
export async function runFailure(
	ctx: VerbContext<ReadApi>,
	number: number,
	jobIndex?: number,
): Promise<
	| { job: string; lines: string[] }
	| { job: string; unavailable: string }
	| undefined
> {
	let found: { run: ApiRun; jobs: ApiJob[] };
	try {
		found = await resolveRun(
			ctx,
			{ kind: "number", number },
			"fgj help run get",
		);
	} catch (err) {
		if (err instanceof FgjError && err.code === "not_found") return undefined;
		throw err;
	}
	const named = jobIndex === undefined ? undefined : found.jobs[jobIndex];
	const job =
		named ?? found.jobs.find((j) => j.status === "failure") ?? found.jobs[0];
	return job ? failureOf(ctx, {}, job) : undefined;
}

/** The run's shared fields. */
function runFields(run: ApiRun, jobs: ApiJob[]) {
	return {
		number: run.index_in_repo,
		status: run.status,
		event: run.event,
		ref: run.prettyref,
		sha: run.commit_sha,
		title: run.title,
		url: run.html_url,
		// The attempt shows only for a re-run job, where --attempt applies.
		jobs: jobs.map((j) => ({
			name: j.name,
			status: j.status,
			...(j.attempt > 1 ? { attempt: j.attempt } : {}),
		})),
	};
}

/** The run as hints name it: the caller's run URL, else the run number. */
function runArg(ref: RunRef, run: ApiRun): string {
	return ref.kind === "number" && ref.url ? ref.url : String(run.index_in_repo);
}

/** A run that has not ended: its status changes, so reading it again helps. */
const PENDING = new Set(["waiting", "running", "blocked"]);

/**
 * Cuts lines until the result fits the output cap. `fromEnd` keeps the last
 * lines, as --tail asks.
 */
function fitLines(
	out: Record<string, unknown>,
	lines: string[],
	fromEnd: boolean,
): { lines: string[]; cut: boolean } {
	if (JSON.stringify({ ...out, lines }).length <= OUTPUT_CAP - 500) {
		return { lines, cut: false };
	}
	let size = JSON.stringify({ ...out, lines: [] }).length + 300;
	const kept: string[] = [];
	const order = fromEnd ? [...lines].reverse() : lines;
	for (const line of order) {
		size += JSON.stringify(line).length + 1;
		if (size > OUTPUT_CAP - 800) break;
		kept.push(line);
	}
	return { lines: fromEnd ? kept.reverse() : kept, cut: true };
}

interface GetInput {
	ref: RunRef;
}

/** `fgj read run get <run> | --pr N | --commit SHA`. */
export const runGet: ReadVerb<GetInput> = {
	risk: "read",
	noun: "run",
	action: "get",
	summary:
		"Read an Actions run: status, jobs, and for a failure the lines that explain it.",
	notes: [
		...RUN_NOTES,
		"A failed run adds failure: {job, lines}, the error lines of the first failed job with a few lines around each, at most 60 lines. Timestamps, colors, and lines with a masked *** are removed.",
		"For more of a log, use run log: --match TEXT, --tail N, or --job.",
	],
	args: [RUN_ARG],
	flags: [...RUN_FLAGS, REPO_FLAG],
	output:
		"{number, status, event, ref, sha, title, url, jobs:[{name, status}]}, and for a failed run failure:{job, lines} or failure:{job, unavailable}.",
	examples: ["fgj read run get 40", "fgj read run get --pr 133"],
	prepare(args: ParsedArgs): GetInput {
		return { ref: runRef(args, "fgj help run get") };
	},
	remoteOf(input) {
		return input.ref.kind === "number" ? input.ref.remote : undefined;
	},
	async run(input, ctx) {
		const hint = "fgj help run get";
		const { run, jobs } = await resolveRun(ctx, input.ref, hint);
		const arg = runArg(input.ref, run);
		const out: Record<string, unknown> = runFields(run, jobs);
		const failed = jobs.filter((j) => j.status === "failure");
		// A URL's /jobs/N names the job; else the first failed job.
		const named =
			input.ref.kind === "number" && input.ref.job !== undefined
				? jobs[input.ref.job]
				: undefined;
		if (input.ref.kind === "number" && input.ref.job !== undefined && !named) {
			throw new FgjError(
				"usage",
				`Run ${run.index_in_repo} has no job ${input.ref.job}; it has ${jobs.length}.`,
				hint,
			);
		}
		// A named job that did not fail has no block: show the failed one.
		const target = named?.status === "failure" ? named : failed[0];
		if (target) {
			out.failure = await failureOf(
				ctx,
				out,
				target,
				input.ref.kind === "number" && target === named
					? input.ref.attempt
					: undefined,
			);
			const other = failed.find((j) => j !== target);
			if (other) {
				out.hint = ctx.commandFor("read run log", [arg], { job: other.name });
			}
		}
		if (!out.hint && PENDING.has(run.status)) {
			out.hint = ctx.commandFor("read run get", [arg]);
		}
		return out;
	},
};

interface LogInput {
	ref: RunRef;
	job?: string;
	match: string[];
	tail?: number;
	attempt?: number;
}

/** Picks the job: --job by name or 0-based index, the URL's job, else the one failed job. */
function pickJob(
	jobs: ApiJob[],
	input: LogInput,
	number: number,
	arg: string,
	ctx: VerbContext<ReadApi>,
): ApiJob {
	const names = jobs.map((j, i) => `${i} (${j.name}, ${j.status})`).join(", ");
	const hint = (job: string) => ctx.commandFor("read run log", [arg], { job });
	const wanted =
		input.job ??
		(input.ref.kind === "number" && input.ref.job !== undefined
			? String(input.ref.job)
			: undefined);
	if (wanted !== undefined) {
		const byIndex = /^\d+$/.test(wanted) ? jobs[Number(wanted)] : undefined;
		const byName = jobs.filter(
			(j) => j.name.toLowerCase() === wanted.toLowerCase(),
		);
		const job = byIndex ?? (byName.length === 1 ? byName[0] : undefined);
		if (!job) {
			throw new FgjError(
				"usage",
				`Run ${number} has no job "${wanted}". Jobs: ${names}.`,
				"fgj help run log",
			);
		}
		return job;
	}
	if (jobs.length === 1) return jobs[0] as ApiJob;
	const failed = jobs.filter((j) => j.status === "failure");
	if (failed.length === 1) return failed[0] as ApiJob;
	const first = (failed[0] ?? jobs[0])?.name ?? "0";
	throw new FgjError(
		"usage",
		`Run ${number} has ${jobs.length} jobs${failed.length > 1 ? `, ${failed.length} failed` : ""}. Name one with --job: ${names}.`,
		hint(first),
	);
}

/** `fgj read run log <run> [--job NAME|N] [--match TEXT]... [--tail N] [--attempt N]`. */
export const runLog: ReadVerb<LogInput> = {
	risk: "read",
	noun: "run",
	action: "log",
	summary:
		"Read part of an Actions job log: error lines, lines that match a text, or the last lines.",
	notes: [
		...RUN_NOTES,
		"With no option, it returns the error lines of the job, as run get does. --match finds a text anywhere in the log, without case, with 3 lines around each hit; repeat it for more texts. --tail N returns the last N lines.",
		"--job takes the job name or its 0-based index, as in the URL /jobs/0. Without it, fgj reads the only job, or the only failed job.",
		"The latest attempt is the default; --attempt N reads an earlier one.",
	],
	args: [RUN_ARG],
	flags: [
		...RUN_FLAGS,
		{
			name: "job",
			kind: "string",
			value: "NAME|N",
			description: "The job name, or its 0-based index as in the URL.",
		},
		{
			name: "match",
			kind: "list",
			value: "TEXT",
			description: "Plain text to find, without case. Repeat it for more.",
		},
		{
			name: "tail",
			kind: "int",
			description: "The last N lines (1-500).",
		},
		{
			name: "attempt",
			kind: "int",
			description: "The attempt of a re-run job. Default: the latest.",
		},
		REPO_FLAG,
	],
	output:
		"{number, job, result, lines}; result is the job's status (success, failure, cancelled, running, …). {number, job, unavailable} when the log does not exist. --match adds hits; a --tail cut to fit adds next.",
	examples: [
		"fgj read run log 40",
		"fgj read run log 40 --match ETIMEDOUT --match warn",
	],
	prepare(args: ParsedArgs): LogInput {
		const hint = "fgj help run log";
		const match = (args.flags.match as readonly string[] | undefined) ?? [];
		const tail = args.flags.tail as number | undefined;
		if (match.length > 0 && tail !== undefined) {
			throw new FgjError("usage", "Use --match or --tail, not both.", hint);
		}
		if (tail !== undefined && (tail < 1 || tail > 500)) {
			throw new FgjError("usage", `--tail takes 1 to 500, got ${tail}.`, hint);
		}
		if (match.some((m) => m.trim() === "")) {
			throw new FgjError("usage", "--match needs a text.", hint);
		}
		const job = args.flags.job;
		const ref = runRef(args, hint);
		const flag = args.flags.attempt as number | undefined;
		if (flag !== undefined && (flag < 1 || flag > 9999)) {
			throw new FgjError(
				"usage",
				`--attempt takes 1 or more, got ${flag}.`,
				hint,
			);
		}
		const attempt = flag ?? (ref.kind === "number" ? ref.attempt : undefined);
		return {
			ref,
			match: [...match],
			...(job === undefined ? {} : { job: String(job) }),
			...(tail === undefined ? {} : { tail }),
			...(attempt === undefined ? {} : { attempt }),
		};
	},
	remoteOf(input) {
		return input.ref.kind === "number" ? input.ref.remote : undefined;
	},
	async run(input, ctx) {
		const hint = "fgj help run log";
		const { run, jobs } = await resolveRun(ctx, input.ref, hint);
		const number = run.index_in_repo;
		if (jobs.length === 0) {
			throw new FgjError("not_found", `Run ${number} has no jobs.`, hint);
		}
		const arg = runArg(input.ref, run);
		const job = pickJob(jobs, input, number, arg, ctx);
		const log = await readLog(ctx, job, input.attempt);
		if ("unavailable" in log) {
			// A job that has not run yet will run: reading the run again helps.
			const again = PENDING.has(job.status);
			return {
				number,
				job: job.name,
				unavailable: log.unavailable,
				...(again ? { hint: ctx.commandFor("read run get", [arg]) } : {}),
			};
		}
		// The API status is the truth for the latest attempt; an older attempt has
		// only its log's end line.
		const latest = input.attempt === undefined || input.attempt === job.attempt;
		const result = latest ? job.status : (jobResult(log.lines) ?? "unknown");
		let lines: string[];
		let hits: number | undefined;
		if (input.match.length > 0) {
			const found = matchLines(log.lines, input.match);
			lines = found.lines;
			hits = found.hits;
		} else if (input.tail !== undefined) {
			lines = log.lines.slice(-input.tail);
		} else {
			lines = errorBlock(log.lines);
		}
		const out: Record<string, unknown> = {
			number,
			job: job.name,
			result,
			...(hits === undefined ? {} : { hits }),
		};
		const fit = fitLines(out, lines, input.tail !== undefined);
		out.lines = fit.lines;
		if (fit.cut && input.tail !== undefined) {
			// The newest lines are kept; a smaller --tail fits as it stands.
			// The job as the caller named it, or its index when a URL named it.
			const named =
				input.job ?? (jobs.length > 1 ? String(jobs.indexOf(job)) : undefined);
			out.next = ctx.commandFor("read run log", [arg], {
				...(named === undefined ? {} : { job: named }),
				...(input.attempt === undefined
					? {}
					: { attempt: String(input.attempt) }),
				tail: String(fit.lines.length),
			});
		} else if (fit.cut) {
			out.note = `The result is cut after ${fit.lines.length} of ${lines.length} lines. Narrow it with --match or use --tail.`;
		}
		if (PENDING.has(job.status) && latest) {
			out.hint = ctx.commandFor("read run get", [arg]);
		}
		return out;
	},
};

/** A run or job status that Forgejo counts as done, so it can re-run. */
const DONE = new Set(["success", "failure", "cancelled", "skipped"]);

interface RerunInput {
	ref: RunRef;
	job?: string;
	dryRun: boolean;
}

/** `fgj write run rerun <run> | --pr N | --commit SHA [--job NAME|N] [--dry-run]`. */
export const runRerun: WriteVerb<RerunInput> = {
	risk: "write",
	noun: "run",
	action: "rerun",
	summary: "Re-run a finished Actions run, or one job, on the same head.",
	notes: [
		RUN_NOTES[0] as string,
		"Forgejo keeps the run number and the commit, and gives each re-run job a new attempt. The commit's check goes back to pending. A re-run deletes all artifacts of the run. run log --attempt N still reads an earlier attempt.",
		"The run must be done: success, failure, cancelled, or skipped. --job NAME|N re-runs one done job and the jobs that need it; a run URL that names a job (/jobs/N) re-runs that job.",
		"A pull_request run whose pull request head has moved is refused: its check belongs to the old head.",
		"It uses the profile's web login, because Forgejo has no API route for a re-run.",
	],
	args: [RUN_ARG],
	flags: [
		...RUN_FLAGS,
		{
			name: "job",
			kind: "string",
			value: "NAME|N",
			description:
				"Re-run one job, by name or 0-based index, and the jobs that need it.",
		},
		DRY_RUN_FLAG,
		REPO_FLAG,
	],
	output:
		"{changed, number, sha, attempt, url, hint}; attempt is the new attempt of the first re-run job. --dry-run: {dry_run, changed, number, sha, status, jobs, apply}; with --job, plus names the jobs that may also re-run, because a job name can hide the YAML key that needs names.",
	examples: [
		"fgj write run rerun 40",
		"fgj write run rerun --pr 133 --job verify",
	],
	prepare(args: ParsedArgs): RerunInput {
		const job = args.flags.job;
		if (job !== undefined && String(job).trim() === "") {
			throw new FgjError(
				"usage",
				"--job needs a name or an index.",
				"fgj help run rerun",
			);
		}
		const ref = runRef(args, "fgj help run rerun");
		// A failed check links its job: that job is the one to re-run.
		const named =
			job === undefined && ref.kind === "number" && ref.job !== undefined
				? String(ref.job)
				: undefined;
		const chosen = job === undefined ? named : String(job);
		return {
			ref,
			...(chosen === undefined ? {} : { job: chosen }),
			dryRun: args.flags["dry-run"] === true,
		};
	},
	remoteOf(input) {
		return input.ref.kind === "number" ? input.ref.remote : undefined;
	},
	async run(input, ctx) {
		const hint = "fgj help run rerun";
		const { owner, name } = ctx.target;
		const { run, jobs } = await resolveRun(ctx, input.ref, hint);
		const number = run.index_in_repo;
		const arg = runArg(input.ref, run);
		const readAgain = ctx.commandFor("read run get", [arg]);
		if (jobs.length === 0) {
			throw new FgjError("not_found", `Run ${number} has no jobs.`, hint);
		}
		// A pull_request run checks the head it ran on; a moved head has its own run.
		const pr = /^#([1-9]\d*)$/.exec(run.prettyref)?.[1];
		if (run.event === "pull_request" && !pr) {
			throw new FgjError(
				"api",
				`Run ${number} is a pull_request run, but its ref "${run.prettyref}" names no pull request, so fgj cannot check its head.`,
				hint,
			);
		}
		if (run.event === "pull_request" && pr) {
			const pull = await ctx.api.get<{ head: { sha: string } }>(
				`/repos/${owner}/${name}/pulls/${pr}`,
			);
			if (pull.head.sha !== run.commit_sha) {
				throw new FgjError(
					"conflict",
					`Run ${number} checked commit ${run.commit_sha.slice(0, 10)} of pull request ${pr}, whose head is now ${pull.head.sha.slice(0, 10)}. A re-run would check the old head.`,
					ctx.commandFor("read run get", [], { pr }),
				);
			}
		}
		const index =
			input.job === undefined ? undefined : jobIndex(jobs, input.job, number);
		const chosen = index === undefined ? undefined : (jobs[index] as ApiJob);
		const status = chosen?.status ?? run.status;
		if (!DONE.has(status)) {
			throw new FgjError(
				"conflict",
				`${chosen ? `Job ${chosen.name} of run ${number}` : `Run ${number}`} is ${status}. Forgejo re-runs only a finished run or job: success, failure, cancelled, or skipped.`,
				readAgain,
			);
		}
		// Fails here, before any change, when the profile has no web login.
		const web = ctx.web();
		if (input.dryRun) {
			const plan = chosen ? rerunPlan(jobs, chosen) : undefined;
			return {
				dry_run: true,
				changed: true,
				number,
				sha: run.commit_sha,
				status,
				jobs: plan ? plan.jobs : jobs.map((j) => j.name),
				...(plan?.plus ? { plus: plan.plus } : {}),
				apply: ctx.commandWith({ "dry-run": undefined }),
			};
		}
		const path = `/${owner}/${name}/actions/runs/${number}${index === undefined ? "" : `/jobs/${index}`}/rerun`;
		const answer = await web.post(path, { form: {} }).catch((err: unknown) => {
			if (err instanceof FgjError && err.code === "not_found") {
				throw new FgjError(
					"not_found",
					`${ctx.target.baseUrl} answered 404 to the re-run of run ${number}: the account needs write access to Actions in ${owner}/${name}.`,
					"fgj auth status",
				);
			}
			if (err instanceof FgjError && err.code === "conflict") {
				// The run changed after fgj read it, or its workflow is disabled.
				throw new FgjError("conflict", err.message, readAgain);
			}
			throw err;
		});
		const url = typeof answer.redirect === "string" ? answer.redirect : "";
		const attempt = /\/attempt\/([1-9]\d*)$/.exec(url)?.[1];
		if (attempt === undefined) {
			throw new FgjError(
				"api",
				`${ctx.target.baseUrl} accepted the re-run of run ${number} but named no new attempt. Read the run to see it.`,
				readAgain,
			);
		}
		return {
			changed: true,
			number,
			sha: run.commit_sha,
			attempt: Number(attempt),
			url,
			hint: readAgain,
		};
	},
};

/**
 * The jobs that a re-run of one job may re-run. Forgejo re-runs the job and
 * the jobs whose `needs` name a job in the re-run set, in one pass in job
 * order. `needs` holds YAML keys, and the REST job list shows only names, which
 * a `name:` can change. So `jobs` holds the jobs that re-run as far as names
 * show; it may list more than Forgejo re-runs. `plus` names every other job
 * with `needs`, which may also re-run. Besides the chosen job, Forgejo re-runs
 * only jobs with `needs`, so `jobs` and `plus` together never list less.
 *
 * @param jobs - The run's jobs, in Forgejo's job order.
 * @param chosen - The job to re-run, one of `jobs`.
 * @returns The jobs that re-run as far as names show, and the jobs that may also re-run.
 * @example
 * const all = [{ name: "build" }, { name: "test", needs: ["build"] }];
 * rerunPlan(all, all[0]); // { jobs: ["build", "test"] }
 */
export function rerunPlan<
	J extends { name: string; needs?: readonly string[] | null },
>(jobs: readonly J[], chosen: J): { jobs: string[]; plus?: string[] } {
	const picked = new Set([chosen]);
	for (let grew = true; grew; ) {
		grew = false;
		const keys = new Set([...picked].map((j) => j.name));
		for (const job of jobs) {
			if (!picked.has(job) && (job.needs ?? []).some((k) => keys.has(k))) {
				picked.add(job);
				grew = true;
			}
		}
	}
	const plus = jobs.filter((j) => !picked.has(j) && (j.needs ?? []).length > 0);
	return {
		jobs: jobs.filter((j) => picked.has(j)).map((j) => j.name),
		...(plus.length > 0 ? { plus: plus.map((j) => j.name) } : {}),
	};
}

/** The 0-based index of the job that --job names, by index or by name. */
function jobIndex(jobs: ApiJob[], wanted: string, number: number): number {
	if (/^\d+$/.test(wanted) && Number(wanted) < jobs.length)
		return Number(wanted);
	const byName = jobs
		.map((j, i) => ({ j, i }))
		.filter(({ j }) => j.name.toLowerCase() === wanted.toLowerCase());
	if (byName.length === 1) return (byName[0] as { i: number }).i;
	const names = jobs.map((j, i) => `${i} (${j.name}, ${j.status})`).join(", ");
	throw new FgjError(
		"usage",
		`Run ${number} has ${byName.length > 1 ? "more than one" : "no"} job "${wanted}". Jobs: ${names}.`,
		"fgj help run rerun",
	);
}

/** A run's status as a wait state: success, failure, or pending. */
function waitState(status: string): "success" | "failure" | "pending" {
	if (status === "success" || status === "skipped") return "success";
	if (status === "failure" || status === "cancelled") return "failure";
	return "pending";
}

/** `fgj read run wait <run> | --pr N | --commit SHA`. */
export const runWait: ReadVerb<GetInput> = {
	risk: "read",
	noun: "run",
	action: "wait",
	summary: "Wait up to 90 s for an Actions run; pending gives next.",
	notes: [
		RUN_NOTES[0] as string,
		"One call waits at most 90 s. A run that has not finished by then returns with next: run that command to wait more. pending_s is how long the run has waited or run.",
		"state is success (success or skipped), failure (failure or cancelled), pending, or none. status keeps Forgejo's own word.",
		"A run number that does not exist is not_found at once. With --pr or --commit, fgj looks for a run up to 20 s, then ends as none: no workflow ran for it.",
		"A failed run adds failure: {job, lines}, as run get does.",
	],
	args: [RUN_ARG],
	flags: [...RUN_FLAGS, REPO_FLAG],
	output:
		"{state, number, status, event, ref, sha, title, url, jobs}, failure for a failed run, pending_s and next while it has not finished; {state: none, commit or pr, note} when no run appeared.",
	examples: ["fgj read run wait 40", "fgj read run wait --pr 133"],
	prepare(args: ParsedArgs): GetInput {
		return { ref: runRef(args, "fgj help run wait") };
	},
	remoteOf(input) {
		return input.ref.kind === "number" ? input.ref.remote : undefined;
	},
	async run(input, ctx) {
		const hint = "fgj help run wait";
		const times = ctx.waitTimes ?? WAIT_TIMES;
		const start = Date.now();
		const last = await pollUntil(
			times,
			async (elapsed) => {
				try {
					const found = await resolveRun(ctx, input.ref, hint);
					return { done: DONE.has(found.run.status), value: found };
				} catch (err) {
					// A push starts its run a moment later: look again within the
					// grace. A missing pull request or commit stays an error.
					const noRun =
						err instanceof FgjError &&
						err.code === "not_found" &&
						input.ref.kind !== "number" &&
						err.message.startsWith("No Actions ");
					if (noRun) return { done: elapsed >= times.grace, value: undefined };
					throw err;
				}
			},
			start,
		);
		if (!last.value) {
			// Time, not the grace, ended the search: it may still appear.
			if (!last.done) return { state: "pending", next: ctx.commandWith({}) };
			const named: Record<string, unknown> = {};
			if (input.ref.kind === "commit") {
				// A full SHA skips resolveRun's commit check; a missing commit is not none.
				const { owner, name } = ctx.target;
				try {
					named.commit = (
						await ctx.api.get<{ sha: string }>(
							`/repos/${owner}/${name}/git/commits/${input.ref.sha}`,
						)
					).sha;
				} catch (err) {
					if (err instanceof FgjError && err.code === "not_found") {
						throw new FgjError(
							"not_found",
							`No commit ${input.ref.sha} in ${owner}/${name}.`,
							hint,
						);
					}
					throw err;
				}
			} else if (input.ref.kind === "pr") {
				named.pr = input.ref.pr;
			}
			return {
				state: "none",
				...named,
				note: "No Actions run appeared for it. none is not a pass: no workflow ran for it, or its run has not started yet.",
			};
		}
		const { run, jobs } = last.value;
		const out: Record<string, unknown> = {
			state: waitState(run.status),
			...runFields(run, jobs),
		};
		const failed = jobs.find((j) => j.status === "failure");
		if (failed) out.failure = await failureOf(ctx, out, failed);
		if (!last.done) {
			// A re-run resets updated; a running attempt has its own start.
			const since =
				run.status === "running" ? run.started : (run.updated ?? run.created);
			const waited = secondsSince(since, Date.now());
			if (waited !== undefined) out.pending_s = waited;
			out.next = ctx.commandWith({});
		}
		return out;
	},
};

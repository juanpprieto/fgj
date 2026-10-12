import { FgjError } from "../core/errors.ts";
import {
	BODY_MAX_DEFAULT,
	BODY_MAX_LIMIT,
	fitItem,
	LIST_LIMIT_DEFAULT,
	LIST_LIMIT_MAX,
	page,
	pick,
	selectFields,
	truncateBody,
} from "../core/output.ts";
import {
	FAILED,
	type LocalEnv,
	type ParsedArgs,
	type ReadVerb,
	type VerbContext,
	type WriteVerb,
} from "../core/verb.ts";
import type { ReadApi, WriteApi } from "../forgejo/client.ts";
import { checkedOut, type Target } from "../forgejo/target.ts";
import {
	assertRepo,
	authorName,
	branchPath,
	DRY_RUN_FLAG,
	type IssueRef,
	issueRef,
	issueRefs,
	OPTIONAL_BODY_FILE_FLAG,
	REPO_FLAG,
	rangeFlag,
	readBodyFile,
	readMany,
	TITLE_MAX,
	titleFlag,
} from "./common.ts";
import { readWindow } from "./issue.ts";
import { repoLabels, resolveLabels } from "./label.ts";
import { readChecks, requiredChecks } from "./status.ts";

/** A Forgejo pull request, reduced to the keys fgj reads. */
interface ApiPull {
	number: number;
	title: string;
	state: string;
	draft: boolean;
	merged: boolean;
	mergeable: boolean;
	body: string | null;
	html_url: string;
	merge_commit_sha: string | null;
	user: { login: string } | null;
	original_author?: string;
	labels: { name: string }[] | null;
	comments: number;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	merged_at: string | null;
	base: { ref: string; sha: string; repo?: { full_name: string } | null };
	head: { ref: string; sha: string; repo?: { full_name: string } | null };
}

/**
 * The output of one pull request, before `pick`: names, not objects. The state
 * is `merged` for a merged PR, and `mergeable` appears only on an open PR.
 */
function pullFields(pull: ApiPull, bodyMax: number): Record<string, unknown> {
	const merged = pull.merged;
	return {
		number: pull.number,
		title: pull.title,
		state: merged ? "merged" : pull.state,
		draft: pull.draft,
		// Forgejo keeps mergeable true after a close or a merge.
		mergeable: pull.state === "open" && !merged ? pull.mergeable : undefined,
		base: pull.base.ref,
		head: pull.head.ref,
		head_sha: pull.head.sha,
		url: pull.html_url,
		...truncateBody(pull.body, bodyMax),
		merge_commit: merged ? pull.merge_commit_sha : undefined,
		author: authorName({
			original_author: pull.original_author ?? "",
			user: pull.user,
		}),
		labels: (pull.labels ?? []).map((l) => l.name),
		base_sha: pull.base.sha,
		comments: pull.comments,
		created_at: pull.created_at,
		updated_at: pull.updated_at,
		closed_at: pull.closed_at,
		merged_at: pull.merged_at,
	};
}

/** The most pull requests that one `pr get` reads. */
const GET_MAX = 50;

const GET_FIELDS = {
	all: [
		"number",
		"title",
		"state",
		"draft",
		"mergeable",
		"base",
		"head",
		"head_sha",
		"url",
		"body",
		"merge_commit",
		"author",
		"labels",
		"base_sha",
		"comments",
		"created_at",
		"updated_at",
		"closed_at",
		"merged_at",
	],
	default: [
		"number",
		"title",
		"state",
		"draft",
		"mergeable",
		"base",
		"head",
		"head_sha",
		"url",
		"body",
		"merge_commit",
	],
} as const;

interface GetInput {
	refs: IssueRef[];
	/** The branch whose open PR to read, instead of numbers. */
	head?: string;
	remote?: IssueRef["remote"];
	single: boolean;
	fields: readonly string[];
	bodyMax: number;
}

/** `fgj read pr get <pr...>`: one or many pull requests, by number. */
export const prGet: ReadVerb<GetInput> = {
	risk: "read",
	noun: "pr",
	action: "get",
	summary:
		"Read one or many pull requests: state, draft, mergeable, branches, head SHA, and body.",
	notes: [
		"One PR returns the PR itself. Two or more return {items, missing}; missing lists the numbers that are not pull requests, and only when there are some.",
		"state is open, closed, or merged. merge_commit appears only on a merged PR.",
		"base and head are branch names; head_sha is the full SHA of the head commit.",
		"An issue number is not a pull request: use issue get for it. A number in missing can be an issue.",
		"mergeable appears only on an open PR.",
		"--head BRANCH reads the open PR of a branch in this repository, in the same shape as one number. A branch with open PRs into two bases fails with conflict and names both.",
	],
	args: [
		{
			name: "pr...",
			description: `Pull request numbers, or their URLs, at most ${GET_MAX}. Leave them out with --head.`,
		},
	],
	flags: [
		{
			name: "head",
			kind: "string",
			value: "BRANCH",
			description: "The branch whose open pull request to read.",
		},
		{
			name: "fields",
			kind: "fields",
			value: "a,b",
			description: "Comma list of fields. Alone, it lists the fields.",
		},
		{
			name: "body-max",
			kind: "int",
			description: `Most body characters per PR (1-${BODY_MAX_LIMIT}, default ${BODY_MAX_DEFAULT}).`,
		},
		REPO_FLAG,
	],
	fields: GET_FIELDS,
	output:
		"One PR: {number, title, state, draft, mergeable, base, head, head_sha, url, body}; mergeable only when open, merge_commit only when merged. Many: {items, missing, next}. A cut body adds body_truncated, body_chars, and a hint.",
	examples: ["fgj read pr get 42", "fgj read pr get --head feat/12-login"],
	prepare(args: ParsedArgs): GetInput {
		const hint = "fgj help pr get";
		const head = args.flags.head;
		if (head !== undefined && args.positionals.length > 0) {
			throw new FgjError(
				"usage",
				"Give pull request numbers or --head BRANCH, not both.",
				hint,
			);
		}
		const { refs, remote } =
			head === undefined
				? issueRefs(args, GET_MAX, hint, "pull request")
				: { refs: [], remote: undefined };
		if (
			head !== undefined &&
			(String(head).trim() === "" || String(head).includes(":"))
		) {
			throw new FgjError(
				"usage",
				`--head takes a branch of this repository, got "${head}".`,
				hint,
			);
		}
		return {
			refs,
			...(head === undefined ? {} : { head: String(head).trim() }),
			...(remote ? { remote } : {}),
			single: refs.length === 1 || head !== undefined,
			fields: selectFields(args.flags.fields, GET_FIELDS, hint),
			bodyMax: rangeFlag(
				args,
				"body-max",
				1,
				BODY_MAX_LIMIT,
				BODY_MAX_DEFAULT,
				hint,
			),
		};
	},
	remoteOf(input) {
		return input.remote;
	},
	async run(input, ctx) {
		const { target, api } = ctx;
		const repoPath = `/repos/${target.owner}/${target.name}`;
		if (input.head !== undefined) {
			// Forgejo matches the branch name in any head repository, forks too.
			// The base repository is this one, under its current name.
			const found = (
				await api.get<ApiPull[]>(`${repoPath}/pulls`, {
					state: "open",
					head: input.head,
					page: 1,
					limit: 50,
				})
			).filter(
				(p) =>
					p.head.repo?.full_name !== undefined &&
					p.head.repo.full_name === p.base.repo?.full_name,
			);
			const [pull] = found;
			if (found.length > 1) {
				throw new FgjError(
					"conflict",
					`The branch ${input.head} has ${found.length} open pull requests: ${found.map((p) => `#${p.number} into ${p.base.ref}`).join(", ")}. Read one by number.`,
					ctx.commandFor("read pr list", []),
				);
			}
			if (!pull) {
				throw new FgjError(
					"not_found",
					`No open pull request for the branch ${input.head} in ${target.owner}/${target.name}.`,
					ctx.commandFor("read pr list", [], { state: "all" }),
				);
			}
			const item = fitItem(pick(pullFields(pull, input.bodyMax), input.fields));
			return item.body_truncated
				? {
						...item,
						hint: ctx.commandFor("read pr get", [String(pull.number)], {
							"body-max": String(BODY_MAX_LIMIT),
						}),
					}
				: item;
		}
		const readOne = async (n: number) => {
			let pull: ApiPull;
			try {
				pull = await api.get<ApiPull>(`${repoPath}/pulls/${n}`);
			} catch (err) {
				if (err instanceof FgjError && err.code === "not_found") return null;
				throw err;
			}
			return fitItem(pick(pullFields(pull, input.bodyMax), input.fields));
		};
		// The PR endpoint answers 404 for an issue too; name it when it is one.
		const missingOne = async (ref: IssueRef) => {
			try {
				await api.get(`${repoPath}/issues/${ref.number}`);
			} catch (err) {
				if (err instanceof FgjError && err.code === "not_found") {
					return new FgjError(
						"not_found",
						`Pull request ${ref.number} does not exist in ${target.owner}/${target.name}.`,
						"fgj help pr get",
					);
				}
				throw err;
			}
			throw new FgjError(
				"not_found",
				`#${ref.number} in ${target.owner}/${target.name} is an issue, not a pull request.`,
				ctx.commandFor("read issue get", [ref.canonical]),
			);
		};
		return readMany(input, ctx, readOne, missingOne, "fgj help pr get");
	},
};

const LIST_FIELDS = {
	all: GET_FIELDS.all,
	default: [
		"number",
		"title",
		"state",
		"draft",
		"head",
		"base",
		"url",
		"head_sha",
		"labels",
	],
} as const;

/** The states that the server filters. Merged PRs are in closed. */
const LIST_STATES = ["open", "closed", "all"] as const;

interface ListInput {
	state: (typeof LIST_STATES)[number];
	base?: string;
	author?: string;
	label?: string;
	fields: readonly string[];
	bodyMax: number;
	limit: number;
	offset: number;
}

/** `fgj read pr list`: one page of the repository's pull requests. */
export const prList: ReadVerb<ListInput> = {
	risk: "read",
	noun: "pr",
	action: "list",
	summary:
		"List pull requests, newest first. Filter by state, base, author, and label.",
	notes: [
		"--state closed lists closed and merged PRs; each item's state says which. Forgejo cannot filter merged PRs alone.",
		"--label takes one label name, matched without case. Forgejo filters PRs by one label only.",
		"For the PR of one branch, use pr get --head BRANCH.",
	],
	args: [],
	flags: [
		{
			name: "state",
			kind: "string",
			value: "open|closed|all",
			description: "Which pull requests to list (default open).",
		},
		{
			name: "base",
			kind: "string",
			value: "BRANCH",
			description: "Only pull requests into this branch.",
		},
		{
			name: "author",
			kind: "string",
			value: "USER",
			description: "Only pull requests that this user opened.",
		},
		{
			name: "label",
			kind: "string",
			value: "NAME",
			description: "Only pull requests with this label.",
		},
		{
			name: "fields",
			kind: "fields",
			value: "a,b",
			description: "Comma list of fields. Alone, it lists the fields.",
		},
		{
			name: "body-max",
			kind: "int",
			description: `Most body characters per PR (1-${BODY_MAX_LIMIT}, default ${BODY_MAX_DEFAULT}).`,
		},
		{
			name: "limit",
			kind: "int",
			description: `Most pull requests per page (1-${LIST_LIMIT_MAX}, default ${LIST_LIMIT_DEFAULT}).`,
		},
		{
			name: "offset",
			kind: "int",
			description: "Index of the first pull request. `next` sets it for you.",
		},
		REPO_FLAG,
	],
	fields: LIST_FIELDS,
	output:
		"{items:[{number, title, state, draft, head, base, url, head_sha, labels}], total, next}. next is the exact command for the next page, or null.",
	examples: [
		"fgj read pr list",
		"fgj read pr list --state all --author team.backend --label type/bug",
	],
	prepare(args: ParsedArgs): ListInput {
		const hint = "fgj help pr list";
		const state = args.flags.state ?? "open";
		if (!LIST_STATES.includes(state as ListInput["state"])) {
			throw new FgjError(
				"usage",
				`--state must be open, closed, or all, got "${String(state)}". A merged PR is in closed.`,
				hint,
			);
		}
		const text = (name: "base" | "author" | "label") => {
			const raw = args.flags[name];
			if (raw === undefined) return {};
			const value = String(raw).trim();
			if (value === "") {
				throw new FgjError("usage", `--${name} needs a value.`, hint);
			}
			if (name === "label" && value.includes(",")) {
				throw new FgjError(
					"usage",
					"--label takes one label name. Forgejo filters pull requests by one label only.",
					hint,
				);
			}
			return { [name]: value };
		};
		return {
			state: state as ListInput["state"],
			...text("base"),
			...text("author"),
			...text("label"),
			fields: selectFields(args.flags.fields, LIST_FIELDS, hint),
			bodyMax: rangeFlag(
				args,
				"body-max",
				1,
				BODY_MAX_LIMIT,
				BODY_MAX_DEFAULT,
				hint,
			),
			limit: rangeFlag(
				args,
				"limit",
				1,
				LIST_LIMIT_MAX,
				LIST_LIMIT_DEFAULT,
				hint,
			),
			offset: rangeFlag(args, "offset", 0, Number.MAX_SAFE_INTEGER, 0, hint),
		};
	},
	async run(input, { target, api, commandWith, commandFor }) {
		// The server takes label ids only: a name gives HTTP 500.
		const label =
			input.label === undefined
				? undefined
				: resolveLabels(
						await repoLabels(api, target),
						[input.label],
						"fgj help pr list",
						{ archived: true, listHint: commandFor("read label list", []) },
					)[0];
		const query = {
			state: input.state,
			...(input.base === undefined ? {} : { base: input.base }),
			...(input.author === undefined ? {} : { poster: input.author }),
			...(label === undefined ? {} : { labels: label.id }),
		};
		const path = `/repos/${target.owner}/${target.name}/pulls`;
		let window: ApiPull[];
		let total: number;
		try {
			({ items: window, total } = await readWindow(
				(page, limit) => api.list<ApiPull>(path, { ...query, limit, page }),
				input.offset,
				input.limit,
				async () =>
					(await api.get<{ max_response_items: number }>("/settings/api"))
						.max_response_items,
			));
		} catch (err) {
			// An unknown user gives HTTP 400.
			if (
				err instanceof FgjError &&
				err.status === 400 &&
				input.author !== undefined
			) {
				throw new FgjError(
					"not_found",
					`No user ${input.author} on ${target.baseUrl}.`,
					"fgj help pr list",
				);
			}
			throw err;
		}
		const items = window.map((pull) =>
			fitItem(pick(pullFields(pull, input.bodyMax), input.fields)),
		);
		const next = (at: number) => commandWith({ offset: at });
		const shown = page(items, 0, items.length, (end) =>
			next(input.offset + end),
		);
		const end = input.offset + shown.items.length;
		return {
			items: shown.items,
			total,
			next: shown.next ?? (end < total ? next(end) : null),
		};
	},
};

/**
 * Forgejo's default work-in-progress prefixes. A title that starts with one,
 * in any case, marks a draft: Forgejo 16 has no draft field.
 */
const DRAFT_PREFIX = /^(?:WIP:|\[WIP\])[ \t]*/i;

/**
 * Builds a pull request title with the draft prefix set or removed. The title
 * text and the prefix change apart: a new title on a draft stays a draft.
 *
 * @param current - The title that the PR has now, or `""` for a new PR.
 * @param title - The new title with no prefix, or `undefined` to keep the text.
 * @param draft - `true` adds the prefix, `false` removes it, `undefined` keeps the state.
 * @returns The title to send.
 * @example
 * retitle("WIP: Add login", "Add the login page", undefined); // "WIP: Add the login page"
 * retitle("WIP: Add login", undefined, false); // "Add login"
 */
export function retitle(
	current: string,
	title: string | undefined,
	draft: boolean | undefined,
): string {
	const prefix = DRAFT_PREFIX.exec(current)?.[0];
	const text = title ?? (prefix ? current.slice(prefix.length) : current);
	return (draft ?? prefix !== undefined) ? `${prefix ?? "WIP: "}${text}` : text;
}

/** Reads `--title` for a PR verb, and refuses a draft prefix in it. */
function prTitle(
	args: ParsedArgs,
	hint: string,
	required: boolean,
): string | undefined {
	const title = titleFlag(args, hint, required);
	if (title !== undefined && DRAFT_PREFIX.test(title)) {
		throw new FgjError(
			"usage",
			`Give --title without the ${DRAFT_PREFIX.exec(title)?.[0].trim()} prefix, and add --draft.`,
			hint,
		);
	}
	return title;
}

/** Refuses a title that the draft prefix makes too long. */
function assertTitleFits(title: string, hint: string): void {
	if (Array.from(title).length > TITLE_MAX) {
		throw new FgjError(
			"usage",
			`With the draft prefix, the title has more than ${TITLE_MAX} characters. Give a shorter --title.`,
			hint,
		);
	}
}

/**
 * Reads one pull request. A number with no pull request fails with not_found,
 * and the message says when the number is an issue.
 */
async function readPull(
	api: Pick<ReadApi, "get">,
	target: Target,
	ref: IssueRef,
	hint: string,
	issueHint: string,
): Promise<ApiPull> {
	const repoPath = `/repos/${target.owner}/${target.name}`;
	const absent = (err: unknown) => {
		if (!(err instanceof FgjError && err.code === "not_found")) throw err;
	};
	try {
		return await api.get<ApiPull>(`${repoPath}/pulls/${ref.number}`);
	} catch (err) {
		absent(err);
	}
	// The PR endpoint answers 404 for an issue too; name it when it is one.
	let issue = false;
	try {
		await api.get(`${repoPath}/issues/${ref.number}`);
		issue = true;
	} catch (err) {
		absent(err);
	}
	if (issue) {
		throw new FgjError(
			"not_found",
			`#${ref.number} in ${target.owner}/${target.name} is an issue, not a pull request.`,
			issueHint,
		);
	}
	await assertRepo(api, target, hint);
	throw new FgjError(
		"not_found",
		`Pull request ${ref.number} does not exist in ${target.owner}/${target.name}.`,
		hint,
	);
}

interface CreateInput {
	title: string;
	body: string;
	base?: string;
	head?: string;
	/** The checked-out branch and its commit, when --head is not given. */
	local?: { branch: string; sha: string };
	draft: boolean;
	dryRun: boolean;
}

/** Reads a branch flag. */
function branchFlag(
	args: ParsedArgs,
	name: "base" | "head",
	hint: string,
): string | undefined {
	const raw = args.flags[name];
	if (raw === undefined) return undefined;
	const branch = String(raw).trim();
	if (branch === "") {
		throw new FgjError("usage", `--${name} needs a branch name.`, hint);
	}
	if (name === "head" && branch.includes(":")) {
		throw new FgjError(
			"usage",
			`--head takes a branch of this repository, got "${branch}". fgj does not open a PR from another repository.`,
			hint,
		);
	}
	return branch;
}

/**
 * `fgj write pr create --title TEXT`: opens a pull request. A repeat returns
 * the open PR for the same head and base.
 */
export const prCreate: WriteVerb<CreateInput> = {
	risk: "write",
	noun: "pr",
	action: "create",
	summary:
		"Open a pull request from a branch. A repeat returns the open PR for the same head and base with changed:false.",
	notes: [
		"--head defaults to the branch checked out in the working directory. The server must have that branch at the same commit, so push it first. --base defaults to the repository's default branch.",
		"changed:false means an open PR for this head and base already exists; fgj did not change its title or body. Use pr edit for that.",
		"--draft adds the WIP: title prefix: Forgejo 16 has no draft field, and the prefix marks a draft. Give --title without it.",
		"The result is {changed, pr, url}; it does not repeat the title or the body.",
	],
	args: [],
	flags: [
		{
			name: "title",
			kind: "string",
			value: "TEXT",
			required: true,
			description: `The PR title (1-${TITLE_MAX} characters), with no WIP: prefix. Quote it.`,
		},
		OPTIONAL_BODY_FILE_FLAG,
		{
			name: "base",
			kind: "string",
			value: "BRANCH",
			description: "The branch to merge into. Default: the default branch.",
		},
		{
			name: "head",
			kind: "string",
			value: "BRANCH",
			description:
				"The branch to merge, in this repository. Default: the checked-out branch.",
		},
		{
			name: "draft",
			kind: "bool",
			description: "Open the PR as a draft (WIP: prefix).",
		},
		DRY_RUN_FLAG,
		REPO_FLAG,
	],
	output:
		"{changed, pr, url}. changed:false means an open PR for this head and base already existed. --dry-run: {dry_run, changed, pr, apply}; pr only when one exists.",
	examples: [
		"fgj write pr create --title 'Add the login page' --body-file /tmp/pr.md",
		"fgj write pr create --title 'Add the login page' --head feat/12-login --base main --draft",
	],
	prepare(args: ParsedArgs, local: LocalEnv): CreateInput {
		const hint = "fgj help pr create";
		if (args.positionals.length > 0) {
			throw new FgjError(
				"usage",
				`pr create takes no argument, got ${args.positionals.join(" ")}. Quote the title: --title 'Two words'.`,
				hint,
			);
		}
		const base = branchFlag(args, "base", hint);
		const head = branchFlag(args, "head", hint);
		if (head !== undefined && head === base) {
			throw new FgjError(
				"usage",
				`--head and --base are both ${head}. A PR merges one branch into another.`,
				hint,
			);
		}
		let checkout: CreateInput["local"];
		if (head === undefined) {
			checkout = checkedOut(local.cwd) ?? undefined;
			if (!checkout) {
				throw new FgjError(
					"usage",
					"No branch is checked out in the working directory. Give --head BRANCH.",
					hint,
				);
			}
		}
		const flag = args.flags["body-file"];
		return {
			title: prTitle(args, hint, true) as string,
			body: flag === undefined ? "" : readBodyFile(flag, local, hint),
			...(base === undefined ? {} : { base }),
			...(head === undefined ? {} : { head }),
			...(checkout ? { local: checkout } : {}),
			draft: args.flags.draft === true,
			dryRun: args.flags["dry-run"] === true,
		};
	},
	async run(input, { target, api, commandWith }) {
		const hint = "fgj help pr create";
		const repoPath = `/repos/${target.owner}/${target.name}`;
		const title = input.draft ? retitle("", input.title, true) : input.title;
		assertTitleFits(title, hint);
		const base =
			input.base ??
			(await api.get<{ default_branch: string }>(repoPath)).default_branch;
		const head = (input.head ?? input.local?.branch) as string;
		if (head === base) {
			throw new FgjError(
				"usage",
				`The head branch ${head} is the base branch. Check out the work branch, or give --head BRANCH.`,
				hint,
			);
		}
		{
			let remote: { commit: { id: string } };
			try {
				remote = await api.get(branchPath(target, head));
			} catch (err) {
				if (err instanceof FgjError && err.code === "not_found") {
					throw new FgjError(
						"not_found",
						`The server has no branch ${head} in ${target.owner}/${target.name}. Push it first: git push -u origin ${head}.`,
						hint,
					);
				}
				throw err;
			}
			// A default head must be pushed as it is, or the PR shows other commits.
			if (input.local && remote.commit.id !== input.local.sha) {
				throw new FgjError(
					"conflict",
					`The server has ${head} at ${remote.commit.id.slice(0, 10)}, and the checkout is at ${input.local.sha.slice(0, 10)}. Push the branch, or pull it, then retry.`,
					hint,
				);
			}
		}
		const open = async () => {
			const [pull] = await api.get<ApiPull[]>(`${repoPath}/pulls`, {
				state: "open",
				base,
				head,
				limit: 1,
			});
			return pull;
		};
		const send = { head, base, title, body: input.body };
		if (input.dryRun) {
			api.assertSendable(send);
			const existing = await open();
			return {
				dry_run: true,
				changed: existing === undefined,
				...(existing ? { pr: existing.number } : {}),
				apply: commandWith({ "dry-run": undefined }),
			};
		}
		try {
			const created = await api.send<ApiPull>(
				"POST",
				`${repoPath}/pulls`,
				send,
			);
			return { changed: true, pr: created.number, url: created.html_url };
		} catch (err) {
			// 409: an open PR for this head and base exists. Return it.
			if (!(err instanceof FgjError && err.status === 409)) throw err;
			const existing = await open();
			if (!existing) throw err;
			return { changed: false, pr: existing.number, url: existing.html_url };
		}
	},
};

interface EditInput {
	ref: IssueRef;
	title: string | undefined;
	body: string | undefined;
	/** `true` for --draft, `false` for --ready. */
	draft: boolean | undefined;
	dryRun: boolean;
}

/**
 * `fgj write pr edit <pr>`: changes the title, the body, or the draft state.
 * Only what differs is sent, so a repeat sends nothing.
 */
export const prEdit: WriteVerb<EditInput> = {
	risk: "write",
	noun: "pr",
	action: "edit",
	summary:
		"Change a pull request's title, body, or draft state. What is already so returns changed:false.",
	notes: [
		"--body-file replaces the whole body. To change part of it, read it whole first with pr get --body-max 20000.",
		"--draft adds the WIP: title prefix, and --ready removes it. --title gives the text without the prefix; a draft stays a draft.",
	],
	args: [{ name: "pr", description: "Pull request number, or its URL." }],
	flags: [
		{
			name: "title",
			kind: "string",
			value: "TEXT",
			description: `The PR title (1-${TITLE_MAX} characters), with no WIP: prefix. Quote it.`,
		},
		OPTIONAL_BODY_FILE_FLAG,
		{
			name: "draft",
			kind: "bool",
			description: "Mark the PR as a draft (add the WIP: prefix).",
		},
		{
			name: "ready",
			kind: "bool",
			description: "Mark the PR as ready (remove the WIP: prefix).",
		},
		DRY_RUN_FLAG,
		REPO_FLAG,
	],
	output: "{changed, pr}. --dry-run adds dry_run and apply.",
	examples: [
		"fgj write pr edit 42 --body-file /tmp/pr.md",
		"fgj write pr edit 42 --ready",
	],
	prepare(args: ParsedArgs, local: LocalEnv): EditInput {
		const hint = "fgj help pr edit";
		const ref = issueRef(args, hint, "pull request");
		if (args.flags.draft === true && args.flags.ready === true) {
			throw new FgjError("usage", "Give --draft or --ready, not both.", hint);
		}
		const flag = args.flags["body-file"];
		const input = {
			ref,
			title: prTitle(args, hint, false),
			body: flag === undefined ? undefined : readBodyFile(flag, local, hint),
			draft:
				args.flags.draft === true
					? true
					: args.flags.ready === true
						? false
						: undefined,
			dryRun: args.flags["dry-run"] === true,
		};
		if (
			input.title === undefined &&
			input.body === undefined &&
			input.draft === undefined
		) {
			throw new FgjError(
				"usage",
				"Nothing to change. Give --title, --body-file, --draft, or --ready.",
				hint,
			);
		}
		return input;
	},
	remoteOf(input) {
		return input.ref.remote;
	},
	async run(input, { target, api, commandWith, commandFor }) {
		const hint = "fgj help pr edit";
		const pull = await readPull(
			api,
			target,
			input.ref,
			hint,
			commandFor("read issue get", [input.ref.canonical]),
		);
		const title = retitle(pull.title, input.title, input.draft);
		assertTitleFits(title, hint);
		const patch = {
			...(title !== pull.title ? { title } : {}),
			...(input.body !== undefined && input.body !== (pull.body ?? "")
				? { body: input.body }
				: {}),
		};
		const changed = Object.keys(patch).length > 0;
		if (input.dryRun) {
			if (changed) api.assertSendable(patch);
			return {
				dry_run: true,
				changed,
				pr: pull.number,
				apply: commandWith({ "dry-run": undefined }, [input.ref.canonical]),
			};
		}
		if (changed) {
			await api.send(
				"PATCH",
				`/repos/${target.owner}/${target.name}/pulls/${pull.number}`,
				patch,
			);
		}
		return { changed, pr: pull.number };
	},
};

interface StateInput {
	refs: IssueRef[];
	remote?: IssueRef["remote"];
	single: boolean;
	dryRun: boolean;
}

/** The outcome of one pull request in a close or reopen. */
type StateItem =
	| { pr: number; changed: boolean }
	| { pr: number; error: ReturnType<FgjError["toJSON"]>["error"] };

/**
 * Builds `pr close` or `pr reopen`: sets the state of one or many pull
 * requests. Each one that already has the state returns changed:false.
 */
function stateVerb(
	action: "close" | "reopen",
	state: "closed" | "open",
): WriteVerb<StateInput> {
	const hint = `fgj help pr ${action}`;
	return {
		risk: "write",
		noun: "pr",
		action,
		summary: `${action === "close" ? "Close" : "Reopen"} one or many pull requests. One already ${state} returns changed:false.`,
		notes: [
			"One PR returns {changed, pr}. Two or more return {changed, items}: one entry per PR, in the order given.",
			"A failure on one PR does not stop the others: its entry has error {code, message, hint}, and the exit code is the code of the first failure. A retry is safe.",
			"A merged PR cannot close or reopen: it fails with conflict, and nothing is sent.",
		],
		args: [
			{
				name: "pr...",
				description: `Pull request numbers, or their URLs, at most ${GET_MAX}.`,
			},
		],
		flags: [DRY_RUN_FLAG, REPO_FLAG],
		output:
			"One PR: {changed, pr}. Many: {changed, items:[{pr, changed} or {pr, error}]}; changed is true when any PR changed. --dry-run adds dry_run and apply.",
		examples: [`fgj write pr ${action} 42`, `fgj write pr ${action} 42 43`],
		prepare(args: ParsedArgs): StateInput {
			const { refs, remote } = issueRefs(args, GET_MAX, hint, "pull request");
			return {
				refs,
				...(remote ? { remote } : {}),
				single: refs.length === 1,
				dryRun: args.flags["dry-run"] === true,
			};
		},
		remoteOf(input) {
			return input.remote;
		},
		async run(input, { target, api, commandWith, commandFor }) {
			const unique = [
				...new Map(input.refs.map((r) => [r.number, r])).values(),
			];
			const one = async (ref: IssueRef): Promise<StateItem> => {
				try {
					const pull = await readPull(
						api,
						target,
						ref,
						hint,
						commandFor("read issue get", [ref.canonical]),
					);
					// Forgejo saves other fields before it refuses a merged PR's state.
					if (pull.merged) {
						throw new FgjError(
							"conflict",
							`Pull request ${ref.number} is merged. A merged PR cannot ${action}.`,
							commandFor("read pr get", [ref.canonical], {
								fields: "number,state,merge_commit",
							}),
						);
					}
					const changed = pull.state !== state;
					if (changed && !input.dryRun) {
						await api.send(
							"PATCH",
							`/repos/${target.owner}/${target.name}/pulls/${ref.number}`,
							{ state },
						);
					}
					return { pr: ref.number, changed };
				} catch (err) {
					if (!(err instanceof FgjError)) throw err;
					const error =
						err.hint === "fgj help"
							? new FgjError(err.code, err.message, hint)
							: err;
					if (input.single) throw error;
					return { pr: ref.number, error: error.toJSON().error };
				}
			};
			// One at a time, so the result order is the order of the changes.
			const items: StateItem[] = [];
			for (const ref of unique) items.push(await one(ref));
			const apply = commandWith(
				{ "dry-run": undefined },
				input.refs.map((r) => r.canonical),
			);
			if (input.single) {
				return {
					...(input.dryRun ? { dry_run: true } : {}),
					...(items[0] as StateItem),
					...(input.dryRun ? { apply } : {}),
				};
			}
			const failed = items.find(
				(i): i is Extract<StateItem, { error: unknown }> => "error" in i,
			);
			return {
				...(input.dryRun ? { dry_run: true } : {}),
				changed: items.some((i) => "changed" in i && i.changed),
				items,
				...(input.dryRun ? { apply } : {}),
				...(failed ? { [FAILED]: failed.error.code } : {}),
			};
		},
	};
}

/** `fgj write pr close <pr...>`. */
export const prClose = stateVerb("close", "closed");

/** `fgj write pr reopen <pr...>`. */
export const prReopen = stateVerb("reopen", "open");

/** The merge styles that `pr merge` accepts. `manually-merged` changes no code. */
const STYLES = [
	"merge",
	"rebase",
	"rebase-merge",
	"squash",
	"fast-forward-only",
] as const;

/** The repository setting that allows each merge style. */
const STYLE_SETTING: Record<(typeof STYLES)[number], string> = {
	merge: "allow_merge_commits",
	rebase: "allow_rebase",
	"rebase-merge": "allow_rebase_explicit",
	squash: "allow_squash_merge",
	"fast-forward-only": "allow_fast_forward_only_merge",
};

/** A full commit SHA: SHA-1 or SHA-256. */
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The waits before each retry of a merge that Forgejo answers with "Please
 * try again later", in milliseconds: 3 retries in about 10 seconds.
 */
export const MERGE_RETRY_WAITS_MS: readonly number[] = [2000, 3000, 5000];

interface MergeInput {
	ref: IssueRef;
	style?: (typeof STYLES)[number];
	head?: string;
	dryRun: boolean;
}

/**
 * Runs `pr merge`: it reads the PR, refuses a state that cannot merge, and
 * sends the merge pinned to the head it read. The dry run reads the default
 * style and the head's check state, and sends nothing.
 *
 * @param input - The PR, the style, the head pin, and the dry-run switch.
 * @param ctx - The verb context.
 * @param sleep - Waits the given milliseconds; a test passes one that returns at once.
 * @returns `{changed, pr, merge_commit}`, or the dry-run plan.
 * @throws {FgjError} usage with no style on a real merge; conflict for a
 *   draft, a closed or unmergeable PR, a moved head, or a refusal by the
 *   server; not_found for a number with no PR.
 * @example
 * await mergePull({ ref: { number: 12, canonical: "12" }, style: "merge", dryRun: false }, ctx, Bun.sleep);
 */
export async function mergePull(
	input: MergeInput,
	ctx: Pick<
		VerbContext<WriteApi>,
		"target" | "api" | "commandWith" | "commandFor"
	>,
	sleep: (ms: number) => Promise<unknown>,
): Promise<Record<string, unknown>> {
	const { target, api, commandWith, commandFor } = ctx;
	const hint = "fgj help pr merge";
	const { ref } = input;
	const dryRun = commandWith({ head: undefined, "dry-run": true }, [
		ref.canonical,
	]);
	if (!input.dryRun && input.style === undefined) {
		throw new FgjError(
			"usage",
			"A merge must name --style. The dry run shows the repository's default style and the head, and its apply holds both.",
			dryRun,
		);
	}
	const repoPath = `/repos/${target.owner}/${target.name}`;
	const path = `${repoPath}/pulls/${ref.number}`;
	const read = () =>
		readPull(
			api,
			target,
			ref,
			hint,
			commandFor("read issue get", [ref.canonical]),
		);
	const merged = (pull: ApiPull, changed: boolean, style?: string) => ({
		...(input.dryRun ? { dry_run: true } : {}),
		changed,
		pr: pull.number,
		merge_commit: pull.merge_commit_sha,
		...(input.dryRun
			? {
					apply: commandWith({ "dry-run": undefined, style }, [ref.canonical]),
				}
			: {}),
	});
	const moved = (sha: string) =>
		new FgjError(
			"conflict",
			`The head of pull request ${ref.number} moved to ${sha.slice(0, 10)}. Read the new head in a new dry run.`,
			dryRun,
		);
	/**
	 * The refusals that fgj finds in a read, before any merge request. A retry
	 * skips the mergeable check: Forgejo reports false while it checks the PR.
	 */
	const refuse = (pull: ApiPull, pin: string | undefined, retry = false) => {
		if (pull.state !== "open") {
			throw new FgjError(
				"conflict",
				`Pull request ${ref.number} is closed. Reopen it before a merge.`,
				commandFor("write pr reopen", [ref.canonical]),
			);
		}
		if (pull.draft) {
			throw new FgjError(
				"conflict",
				`Pull request ${ref.number} is a draft: its title starts with a WIP prefix. Forgejo does not merge a draft.`,
				commandFor("write pr edit", [ref.canonical, "--ready"]),
			);
		}
		if (pin !== undefined && pull.head.sha !== pin) throw moved(pull.head.sha);
		if (!retry && !pull.mergeable) {
			throw new FgjError(
				"conflict",
				`Pull request ${ref.number} cannot merge: it conflicts with ${pull.base.ref}, or Forgejo has not finished its merge check.`,
				commandFor("read pr get", [ref.canonical], {
					fields: "number,mergeable,head_sha",
				}),
			);
		}
	};
	/** A merge that Forgejo refused, with its reason and a hint that fits it. */
	const refusal = (err: FgjError) => {
		const reason = err.message.replace(/^.*?\/merge: /, "").trim();
		// A URL argument names another repository than git origin.
		const repo =
			ref.remote && !target.repoFromFlag
				? { repo: `${target.owner}/${target.name}` }
				: undefined;
		return new FgjError(
			"conflict",
			reason
				? `Forgejo refused the merge: ${reason}`
				: `Forgejo refused the merge (HTTP ${err.status}) and gave no reason.`,
			/status check/i.test(reason)
				? commandFor("read status get", [], {
						pr: String(ref.number),
						...repo,
					})
				: /not an allowed merge style/i.test(reason)
					? commandWith(
							{ style: undefined, head: undefined, "dry-run": true },
							[ref.canonical],
						)
					: commandFor("read pr get", [ref.canonical]),
		);
	};
	const first = await read();
	if (!input.dryRun) {
		if (first.merged) return merged(first, false);
		refuse(first, input.head);
	} else {
		const repo = await api.get<Record<string, unknown>>(repoPath);
		const allowed = (s: (typeof STYLES)[number]) =>
			repo[STYLE_SETTING[s]] !== false;
		// The default style, or the first allowed one when the repository
		// forbids its own default.
		const style =
			input.style ??
			STYLES.find((s) => s === repo.default_merge_style && allowed(s)) ??
			STYLES.find(allowed) ??
			"merge";
		if (first.merged) return merged(first, false, style);
		refuse(first, input.head);
		if (!allowed(style)) {
			throw new FgjError(
				"conflict",
				`${style} is not an allowed merge style for ${target.owner}/${target.name}.`,
				commandWith({ style: undefined }),
			);
		}
		const head = first.head.sha;
		// The same checks as status get --pr: every page, and the base's required checks.
		const checks = await readChecks(
			api,
			target,
			head,
			await requiredChecks(api, target, first.base.ref),
		);
		return {
			dry_run: true,
			changed: true,
			pr: first.number,
			title: first.title,
			base: first.base.ref,
			head,
			style,
			checks: checks.state,
			...(checks.missing && checks.missing.length > 0
				? { missing_checks: checks.missing }
				: {}),
			apply: commandWith({ "dry-run": undefined, style, head }, [
				ref.canonical,
			]),
		};
	}
	// Every attempt merges the head that this read saw, never a later push.
	const pin = first.head.sha;
	const send = {
		Do: input.style,
		head_commit_id: pin,
		delete_branch_after_merge: false,
	};
	for (let attempt = 0; ; attempt++) {
		try {
			await api.send("POST", `${path}/merge`, send);
			break;
		} catch (err) {
			if (!(err instanceof FgjError)) throw err;
			if (err.status === 405 && /try again later/i.test(err.message)) {
				const wait = MERGE_RETRY_WAITS_MS[attempt];
				if (wait === undefined) {
					throw new FgjError(
						"conflict",
						`Forgejo still answers "Please try again later" after ${attempt} retries. It may still check the PR, or the PR may conflict with ${first.base.ref}.`,
						commandWith({}),
					);
				}
				await sleep(wait);
				const again = await read();
				if (again.merged) return merged(again, false);
				refuse(again, pin, true);
				continue;
			}
			// 409 and 405 have many causes: a push, a merge by another call, a
			// conflict of this style, or a rule. The PR shows the first two.
			if (err.status === 405 || err.status === 409) {
				const again = await read();
				if (again.head.sha !== pin) throw moved(again.head.sha);
				if (again.merged) return merged(again, false);
				throw refusal(err);
			}
			// No answer, or a server error: the merge may have happened.
			if (
				err.code === "api" &&
				(err.status === undefined || err.status >= 500)
			) {
				const after = await read();
				if (after.merged && after.head.sha === pin) return merged(after, true);
			}
			throw err;
		}
	}
	// The merge answers with an empty body: read the merge commit.
	return merged(await read(), true);
}

/**
 * `fgj destroy pr merge <pr> --style S`: merges a pull request at the head
 * that it reads first. A merged PR returns changed:false.
 */
export const prMerge: WriteVerb<MergeInput> = {
	risk: "destroy",
	noun: "pr",
	action: "merge",
	summary:
		"Merge a pull request with a named style, pinned to its head. A merged PR returns changed:false. No undo.",
	effect: {
		now: "Merges PR #$1 with --style $style",
		plan: "Plans to merge PR #$1",
		arg: String.raw`^[1-9]\d{0,14}$`,
		values: {
			style: `^(?:${STYLES.join("|")})$`,
			head: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$",
		},
	},
	notes: [
		"The harness asks a human for each call, --dry-run too. Run --dry-run first and show the plan: it names the base branch, the head SHA, the default style, and the head's checks (failure, warning, pending, success, skipped, or none). none means the head has no check, not that checks passed.",
		"The dry run's apply holds --style and --head. --head pins the merge: a head that moved fails with conflict, and the hint is a new dry run.",
		"A draft, a closed PR, or a PR that cannot merge fails with conflict before fgj sends the merge. A refusal by the server, such as a branch protection that needs a passing check, also fails with conflict, and its hint reads the checks.",
		'fgj does not wait for checks, and it keeps the head branch. When Forgejo answers "Please try again later", fgj retries 3 times in about 10 seconds.',
	],
	args: [{ name: "pr", description: "Pull request number, or its URL." }],
	flags: [
		{
			name: "style",
			kind: "string",
			value: "S",
			description: `${STYLES.join(", ")}. A merge needs it; --dry-run without it shows the default.`,
		},
		{
			name: "head",
			kind: "string",
			value: "SHA",
			description:
				"The full head SHA that the merge must match. The dry run shows it.",
		},
		DRY_RUN_FLAG,
		REPO_FLAG,
	],
	output:
		"{changed, pr, merge_commit}. changed:false means the PR was already merged. --dry-run: {dry_run, changed, pr, title, base, head, style, checks, apply}.",
	examples: [
		"fgj destroy pr merge 42 --dry-run",
		"fgj destroy pr merge 42 --style merge --head 3f2c1b0e5d4a3f2c1b0e5d4a3f2c1b0e5d4a3f2c",
	],
	prepare(args: ParsedArgs): MergeInput {
		const hint = "fgj help pr merge";
		const ref = issueRef(args, hint, "pull request");
		const style = args.flags.style;
		if (
			style !== undefined &&
			!STYLES.includes(String(style) as (typeof STYLES)[number])
		) {
			throw new FgjError(
				"usage",
				`--style is one of ${STYLES.join(", ")}, got "${style}".`,
				hint,
			);
		}
		const head = args.flags.head;
		if (head !== undefined && !FULL_SHA.test(String(head).toLowerCase())) {
			throw new FgjError(
				"usage",
				`--head needs the full commit SHA, got "${head}". The dry run shows it.`,
				hint,
			);
		}
		return {
			ref,
			...(style === undefined
				? {}
				: { style: String(style) as (typeof STYLES)[number] }),
			...(head === undefined ? {} : { head: String(head).toLowerCase() }),
			dryRun: args.flags["dry-run"] === true,
		};
	},
	remoteOf(input) {
		return input.ref.remote;
	},
	run(input, ctx) {
		return mergePull(input, ctx, Bun.sleep);
	},
};

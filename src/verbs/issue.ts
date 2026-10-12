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
import type { Target } from "../forgejo/target.ts";
import {
	authorName,
	DRY_RUN_FLAG,
	type IssueRef,
	issueRefs,
	OPTIONAL_BODY_FILE_FLAG,
	REPO_FLAG,
	rangeFlag,
	readBodyFile,
	readMany,
	TITLE_MAX,
	titleFlag,
} from "./common.ts";
import { type ApiLabel, repoLabels, resolveLabels } from "./label.ts";
import {
	type ApiMilestone,
	MILESTONE_FLAG,
	milestoneFlag,
	repoMilestones,
	resolveMilestone,
} from "./milestone.ts";

/** A Forgejo issue or pull request, reduced to the keys fgj reads. */
interface ApiIssue {
	number: number;
	title: string;
	state: string;
	body: string | null;
	labels: { id: number; name: string }[] | null;
	user: { login: string } | null;
	original_author: string;
	assignees: { login: string }[] | null;
	milestone: { id: number; title: string } | null;
	comments: number;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	html_url: string;
	/** Set only on a pull request. */
	pull_request: object | null;
	/** Set on the items of a dependency list. */
	repository?: { full_name: string };
}

/** The most issues that one `issue get` reads. */
const GET_MAX = 50;

/** Forgejo's largest page for dependency lists. */
const DEP_PAGE = 50;

const GET_FIELDS = {
	all: [
		"number",
		"title",
		"state",
		"labels",
		"body",
		"author",
		"assignees",
		"milestone",
		"comments",
		"created_at",
		"updated_at",
		"closed_at",
		"url",
		"depends_on",
		"blocks",
	],
	default: ["number", "title", "state", "labels", "body"],
} as const;

/**
 * Names a linked issue: its number in the target repository, or
 * `owner/name#number` in another one.
 */
function linkName(issue: ApiIssue, target: Target): number | string {
	const full = issue.repository?.full_name;
	const here = `${target.owner}/${target.name}`;
	return full === undefined || full.toLowerCase() === here.toLowerCase()
		? issue.number
		: `${full}#${issue.number}`;
}

/** The most pages fgj reads from one dependency list, as a guard. */
const DEP_PAGES_MAX = 200;

/**
 * Reads every page of an issue's `dependencies` or `blocks` list, as issues.
 * It stops at an empty page, not a short one: a server can page below 50, and
 * Forgejo drops unreadable issues from a page after it cuts the page. An issue
 * the caller cannot read comes back with no number; fgj leaves it out.
 */
async function linkedIssues(
	api: Pick<ReadApi, "get">,
	target: Target,
	issue: number,
	kind: "dependencies" | "blocks",
): Promise<ApiIssue[]> {
	const path = `/repos/${target.owner}/${target.name}/issues/${issue}/${kind}`;
	const all: ApiIssue[] = [];
	for (let p = 1; p <= DEP_PAGES_MAX + 1; p++) {
		const items = await api.get<ApiIssue[]>(path, { limit: DEP_PAGE, page: p });
		if (items.length === 0) return all;
		if (p > DEP_PAGES_MAX) {
			throw new FgjError(
				"api",
				`Issue ${issue} has more than ${DEP_PAGES_MAX} pages of ${kind}; fgj stops there rather than return part of the list.`,
				"fgj help issue get",
			);
		}
		all.push(...items.filter((i) => i.number > 0));
	}
	return all;
}

/**
 * Reads every page of an issue's `dependencies` or `blocks` list.
 *
 * @param api - A client that can send GET.
 * @param target - The repository of the issue.
 * @param issue - The issue number.
 * @param kind - `dependencies` for what it depends on, `blocks` for what it blocks.
 * @returns Issue numbers, and `owner/name#number` for another repository.
 * @example
 * await linked(api, target, 5, "dependencies"); // [3, "acme/web#12"]
 */
export async function linked(
	api: Pick<ReadApi, "get">,
	target: Target,
	issue: number,
	kind: "dependencies" | "blocks",
): Promise<(number | string)[]> {
	return (await linkedIssues(api, target, issue, kind)).map((i) =>
		linkName(i, target),
	);
}

/** The server's refusal to close an issue that has open dependencies. */
const OPEN_DEPENDENCIES =
	"cannot close this issue because it still has open dependencies";

interface GetInput {
	refs: IssueRef[];
	remote?: IssueRef["remote"];
	/** True when the caller named one issue: the result is the issue itself. */
	single: boolean;
	fields: readonly string[];
	bodyMax: number;
}

/**
 * Reads one issue as an output item, or `null` when it does not exist. Link
 * fields cost one request each, so fgj reads them only when selected.
 */
async function readIssue(
	input: GetInput,
	ctx: VerbContext<ReadApi>,
	number: number,
): Promise<Record<string, unknown> | null> {
	const { target, api } = ctx;
	let issue: ApiIssue;
	try {
		issue = await api.get<ApiIssue>(
			`/repos/${target.owner}/${target.name}/issues/${number}`,
		);
	} catch (err) {
		if (err instanceof FgjError && err.code === "not_found") return null;
		throw err;
	}
	const [dependsOn, blocks] = await Promise.all([
		input.fields.includes("depends_on")
			? linked(api, target, number, "dependencies")
			: undefined,
		input.fields.includes("blocks")
			? linked(api, target, number, "blocks")
			: undefined,
	]);
	const item = fitItem(
		pick(
			{
				number: issue.number,
				title: issue.title,
				state: issue.state,
				labels: (issue.labels ?? []).map((l) => l.name),
				...truncateBody(issue.body, input.bodyMax),
				author: authorName(issue),
				assignees: (issue.assignees ?? []).map((a) => a.login),
				milestone: issue.milestone?.title ?? null,
				comments: issue.comments,
				created_at: issue.created_at,
				updated_at: issue.updated_at,
				closed_at: issue.closed_at,
				url: issue.html_url,
				depends_on: dependsOn,
				blocks,
			},
			input.fields,
		),
	);
	return issue.pull_request ? { ...item, pr: true } : item;
}

/** `fgj read issue get <issue...>`: one or many issues, by number. */
export const issueGet: ReadVerb<GetInput> = {
	risk: "read",
	noun: "issue",
	action: "get",
	summary:
		"Read one or many issues or pull requests: title, state, labels, and body.",
	notes: [
		"One issue returns the issue itself. Two or more return {items, missing}; missing lists the numbers that do not exist, and only when there are some.",
		"depends_on and blocks cost one request each per issue, so ask for them only when needed. An issue in another repository shows as owner/name#number.",
		"A pull request carries pr:true.",
		"A result over the output cap stops early; next is the command that reads the rest.",
	],
	args: [
		{
			name: "issue...",
			description: `Issue or pull request numbers, or their URLs, at most ${GET_MAX}.`,
		},
	],
	flags: [
		{
			name: "fields",
			kind: "fields",
			value: "a,b",
			description: "Comma list of fields. Alone, it lists the fields.",
		},
		{
			name: "body-max",
			kind: "int",
			description: `Most body characters per issue (1-${BODY_MAX_LIMIT}, default ${BODY_MAX_DEFAULT}).`,
		},
		REPO_FLAG,
	],
	fields: GET_FIELDS,
	output:
		"One issue: {number, title, state, labels, body}. Many: {items, missing, next}. A cut body adds body_truncated, body_chars, and a hint.",
	examples: [
		"fgj read issue get 157",
		"fgj read issue get 157 158 --fields number,state,depends_on",
	],
	prepare(args: ParsedArgs): GetInput {
		const hint = "fgj help issue get";
		const { refs, remote } = issueRefs(args, GET_MAX, hint);
		return {
			refs,
			...(remote ? { remote } : {}),
			single: refs.length === 1,
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
		return readMany(
			input,
			ctx,
			(n) => readIssue(input, ctx, n),
			async (ref) =>
				new FgjError(
					"not_found",
					`Issue ${ref.number} does not exist in ${ctx.target.owner}/${ctx.target.name}.`,
					"fgj help issue get",
				),
			"fgj help issue get",
		);
	},
};

/** Forgejo's largest page for issue lists. */
const ISSUE_PAGE = 50;

/**
 * Reads the items from `offset` to `offset + limit` of a list that the server
 * pages by number. A server can page below 50. Past page 1, the length of a
 * page cannot show the server's page size, so fgj asks the server for it. On
 * page 1, a short page that does not hold every item shows it exactly.
 *
 * @param fetchPage - Reads one page, with its total.
 * @param offset - The index of the first item.
 * @param limit - The most items to return.
 * @param serverMax - Reads the server's largest page (`max_response_items`).
 * @param pageSize - The page size to ask for first.
 * @returns The items in the window, and the total.
 * @throws {FgjError} An api error when the server's pages do not add up.
 * @example
 * await readWindow((page, limit) => api.list(path, { page, limit }), 45, 10, max);
 */
export async function readWindow<T>(
	fetchPage: (
		page: number,
		limit: number,
	) => Promise<{ items: T[]; total: number }>,
	offset: number,
	limit: number,
	serverMax: () => Promise<number>,
	pageSize: number = ISSUE_PAGE,
): Promise<{ items: T[]; total: number }> {
	let size = pageSize;
	if (offset >= size) {
		const max = await serverMax();
		if (!Number.isInteger(max) || max < 1) {
			throw new FgjError(
				"api",
				`The server sent max_response_items ${String(max)}; fgj needs a whole number above 0 to page.`,
				"fgj auth status",
			);
		}
		size = Math.min(size, max);
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		const first = Math.floor(offset / size) + 1;
		const last = Math.floor((offset + limit - 1) / size) + 1;
		const window: T[] = [];
		let total = 0;
		let smaller: number | undefined;
		for (let p = first; p <= last; p++) {
			const got = await fetchPage(p, size);
			total = got.total;
			const n = got.items.length;
			if (p === 1 && n > 0 && n < size && n < total) {
				smaller = n;
				break;
			}
			window.push(...got.items);
			if (n < size) break;
		}
		if (smaller === undefined) {
			const skip = offset - (first - 1) * size;
			return { items: window.slice(skip, skip + limit), total };
		}
		size = smaller;
	}
	throw new FgjError(
		"api",
		"The server's list pages do not add up to its total. Try again; if it repeats, report it.",
		"fgj auth status",
	);
}

const LIST_FIELDS = {
	all: [
		"number",
		"title",
		"state",
		"labels",
		"body",
		"author",
		"assignees",
		"milestone",
		"comments",
		"created_at",
		"updated_at",
		"closed_at",
		"url",
	],
	default: ["number", "title", "state", "labels"],
} as const;

const STATES = ["open", "closed", "all"] as const;

interface ListInput {
	state: (typeof STATES)[number];
	labels: string[];
	search: string | undefined;
	fields: readonly string[];
	bodyMax: number;
	limit: number;
	offset: number;
}

/** `fgj read issue list`: one page of the repository's issues, newest first. */
export const issueList: ReadVerb<ListInput> = {
	risk: "read",
	noun: "issue",
	action: "list",
	summary:
		"List the repository's issues, newest first. Filter by state, labels, and words.",
	notes: [
		"Pull requests never appear.",
		"--label takes a comma list; an issue must have every label named. Names match without case, and archived labels work too.",
		"--search finds whole words in the title, the body, and the comments: zebra does not find zebraword. A new issue shows up in a search a few seconds after it is made.",
		"Use issue get for depends_on and blocks.",
	],
	args: [],
	flags: [
		{
			name: "state",
			kind: "string",
			value: "open|closed|all",
			description: "Which issues to list (default open).",
		},
		{
			name: "label",
			kind: "string",
			value: "a,b",
			description: "Only issues that have every one of these labels.",
		},
		{
			name: "search",
			kind: "string",
			value: "TEXT",
			description: "Only issues that hold these words.",
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
			description: `Most body characters per issue (1-${BODY_MAX_LIMIT}, default ${BODY_MAX_DEFAULT}).`,
		},
		{
			name: "limit",
			kind: "int",
			description: `Most issues per page (1-${LIST_LIMIT_MAX}, default ${LIST_LIMIT_DEFAULT}).`,
		},
		{
			name: "offset",
			kind: "int",
			description: "Index of the first issue. `next` sets it for you.",
		},
		REPO_FLAG,
	],
	fields: LIST_FIELDS,
	output:
		"{items:[{number, title, state, labels}], total, next}. next is the exact command for the next page, or null.",
	examples: [
		"fgj read issue list --label priority/p0",
		"fgj read issue list --state all --search login",
	],
	prepare(args: ParsedArgs): ListInput {
		const hint = "fgj help issue list";
		const state = args.flags.state ?? "open";
		if (!STATES.includes(state as ListInput["state"])) {
			throw new FgjError(
				"usage",
				`--state must be open, closed, or all, got "${String(state)}".`,
				hint,
			);
		}
		const labels = labelFlag(args, "label", hint);
		const search = args.flags.search;
		if (search !== undefined && String(search).trim() === "") {
			throw new FgjError("usage", "--search needs a word.", hint);
		}
		return {
			state: state as ListInput["state"],
			labels,
			search: search === undefined ? undefined : String(search).trim(),
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
		// The server ignores an unknown or wrong-case label and lists every issue,
		// so resolve the names first.
		const labels =
			input.labels.length === 0
				? []
				: resolveLabels(
						await repoLabels(api, target),
						input.labels,
						"fgj help issue list",
						{ archived: true, listHint: commandFor("read label list", []) },
					).map((l) => l.name);
		const query = {
			type: "issues",
			state: input.state,
			...(labels.length > 0 ? { labels: labels.join(",") } : {}),
			...(input.search === undefined ? {} : { q: input.search }),
		};
		const path = `/repos/${target.owner}/${target.name}/issues`;
		const { items: window, total } = await readWindow(
			(page, limit) => api.list<ApiIssue>(path, { ...query, limit, page }),
			input.offset,
			input.limit,
			async () =>
				(await api.get<{ max_response_items: number }>("/settings/api"))
					.max_response_items,
		);
		const items = window.map((issue) =>
			fitItem(
				pick(
					{
						number: issue.number,
						title: issue.title,
						state: issue.state,
						labels: (issue.labels ?? []).map((l) => l.name),
						...truncateBody(issue.body, input.bodyMax),
						author: authorName(issue),
						assignees: (issue.assignees ?? []).map((a) => a.login),
						milestone: issue.milestone?.title ?? null,
						comments: issue.comments,
						created_at: issue.created_at,
						updated_at: issue.updated_at,
						closed_at: issue.closed_at,
						url: issue.html_url,
					},
					input.fields,
				),
			),
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
 * Reads a comma list of label names from a flag. An absent flag is an empty list.
 *
 * @param args - The parsed arguments.
 * @param name - The flag name without `--`.
 * @param hint - The help command for the error.
 * @returns The names, trimmed, in the order given.
 * @throws {FgjError} A usage error when the flag names no label.
 * @example
 * labelFlag(args, "add-label", "fgj help issue edit"); // ["type/bug", "priority/p1"]
 */
export function labelFlag(
	args: ParsedArgs,
	name: string,
	hint: string,
): string[] {
	const raw = args.flags[name];
	if (raw === undefined) return [];
	const names = String(raw)
		.split(",")
		.map((n) => n.trim())
		.filter(Boolean);
	if (names.length === 0) {
		throw new FgjError("usage", `--${name} needs a label name.`, hint);
	}
	return names;
}

/** The scope of an exclusive label: its name before the last `/`. */
function scopeOf(label: ApiLabel): string | undefined {
	const cut = label.name.lastIndexOf("/");
	return label.exclusive && cut > 0 ? label.name.slice(0, cut) : undefined;
}

/**
 * Resolves the labels to add, and refuses two of one exclusive scope: the
 * server would keep the last one and drop the other with no error.
 */
function labelsToAdd(
	labels: readonly ApiLabel[],
	names: readonly string[],
	hint: string,
	listHint: string,
): ApiLabel[] {
	const found = resolveLabels(labels, names, hint, { listHint });
	const seen = new Map<string, string>();
	for (const label of found) {
		const scope = scopeOf(label);
		if (scope === undefined) continue;
		const other = seen.get(scope);
		if (other !== undefined && other !== label.name) {
			throw new FgjError(
				"usage",
				`${other} and ${label.name} are exclusive labels of the scope ${scope}; an issue holds one of them. Name one.`,
				hint,
			);
		}
		seen.set(scope, label.name);
	}
	return [...new Map(found.map((l) => [l.id, l])).values()];
}

const TITLE_FLAG = {
	name: "title",
	kind: "string",
	value: "TEXT",
	description: `The issue title (1-${TITLE_MAX} characters). Quote it.`,
} as const;

const ADD_LABEL_FLAG = {
	name: "add-label",
	kind: "string",
	value: "a,b",
	description: "Comma list of label names to set.",
} as const;

interface CreateInput {
	title: string;
	body: string;
	labels: string[];
	/** A title or id, `null` for none, or `undefined` when not given. */
	milestone: string | null | undefined;
	dryRun: boolean;
}

/**
 * Finds the milestone that a `--milestone` value names. A call reads the
 * milestones once, before any change.
 *
 * @returns The milestone, `null` for none, or `undefined` when the flag is absent.
 */
async function wantedMilestone(
	value: string | null | undefined,
	ctx: {
		api: Pick<ReadApi, "list">;
		target: Target;
		commandFor: VerbContext<ReadApi>["commandFor"];
	},
	hint: string,
): Promise<ApiMilestone | null | undefined> {
	if (value === undefined || value === null) return value;
	return resolveMilestone(
		await repoMilestones(ctx.api, ctx.target),
		value,
		hint,
		ctx.commandFor("read milestone list", [], { state: "all" }),
	);
}

/**
 * `fgj write issue create --title TEXT`: opens an issue. A retry is safe: when
 * your latest issue has the same title and body, nothing is created.
 */
export const issueCreate: WriteVerb<CreateInput> = {
	risk: "write",
	noun: "issue",
	action: "create",
	summary:
		"Open an issue. A repeat of your latest issue returns changed:false with its number.",
	notes: [
		"Label names match without case. An unknown or archived name, or two labels of one exclusive scope, fails before the create.",
		"--milestone takes a title or an id, as milestone edit reads it. An unknown milestone fails before the create.",
		"The result is {changed, number, url}; it does not repeat the title or the body.",
	],
	args: [],
	flags: [
		{ ...TITLE_FLAG, required: true },
		OPTIONAL_BODY_FILE_FLAG,
		ADD_LABEL_FLAG,
		MILESTONE_FLAG,
		DRY_RUN_FLAG,
		REPO_FLAG,
	],
	output:
		"{changed, number, url}. changed:false means your latest issue, open or closed, already had this title, body, labels, and milestone. --dry-run: {dry_run, changed, number, apply}.",
	examples: [
		"fgj write issue create --title 'Login fails on Safari' --body-file /tmp/issue.md --add-label type/bug",
		"fgj write issue create --title 'Track the release' --dry-run",
	],
	prepare(args: ParsedArgs, local: LocalEnv): CreateInput {
		const hint = "fgj help issue create";
		if (args.positionals.length > 0) {
			throw new FgjError(
				"usage",
				`issue create takes no argument, got ${args.positionals.join(" ")}. Quote the title: --title 'Two words'.`,
				hint,
			);
		}
		const flag = args.flags["body-file"];
		return {
			title: titleFlag(args, hint, true) as string,
			body: flag === undefined ? "" : readBodyFile(flag, local, hint),
			labels: labelFlag(args, "add-label", hint),
			milestone: milestoneFlag(args, hint),
			dryRun: args.flags["dry-run"] === true,
		};
	},
	async run(input, ctx) {
		const { target, api, commandWith, commandFor } = ctx;
		const hint = "fgj help issue create";
		const repoPath = `/repos/${target.owner}/${target.name}`;
		const labels =
			input.labels.length === 0
				? []
				: labelsToAdd(
						await repoLabels(api, target),
						input.labels,
						hint,
						commandFor("read label list", []),
					);
		const milestone = await wantedMilestone(input.milestone, ctx, hint);
		const me = await api.get<{ login: string }>("/user");
		const [latest] = await api.get<ApiIssue[]>(`${repoPath}/issues`, {
			type: "issues",
			state: "all",
			created_by: me.login,
			limit: 1,
		});
		// A repeat also has every label asked for: the first create set them all.
		const repeat =
			latest !== undefined &&
			latest.title === input.title &&
			(latest.body ?? "") === input.body &&
			labels.every((l) => (latest.labels ?? []).some((h) => h.id === l.id)) &&
			(milestone === undefined ||
				(latest.milestone?.id ?? null) === (milestone?.id ?? null));
		const send = {
			title: input.title,
			body: input.body,
			...(labels.length > 0 ? { labels: labels.map((l) => l.id) } : {}),
			...(milestone ? { milestone: milestone.id } : {}),
		};
		if (input.dryRun) {
			if (!repeat) api.assertSendable(send);
			return {
				dry_run: true,
				changed: !repeat,
				...(repeat ? { number: latest.number } : {}),
				apply: commandWith({ "dry-run": undefined }),
			};
		}
		if (repeat) {
			return { changed: false, number: latest.number, url: latest.html_url };
		}
		const created = await api.send<ApiIssue>(
			"POST",
			`${repoPath}/issues`,
			send,
		);
		return { changed: true, number: created.number, url: created.html_url };
	},
};

interface EditInput {
	refs: IssueRef[];
	remote?: IssueRef["remote"];
	/** True when the caller named one issue: the result is the issue itself. */
	single: boolean;
	title: string | undefined;
	body: string | undefined;
	add: string[];
	remove: string[];
	/** A title or id, `null` for none, or `undefined` when not given. */
	milestone: string | null | undefined;
	dryRun: boolean;
}

/** The label names that `after` has and `before` lacks. */
function gained(
	before: readonly { name: string }[],
	after: readonly { name: string }[],
): string[] {
	const had = new Set(before.map((l) => l.name));
	return after.map((l) => l.name).filter((n) => !had.has(n));
}

/** The labels and the milestone of an edit, found once for every issue. */
interface EditPlan {
	all: ApiLabel[];
	add: ApiLabel[];
	remove: ApiLabel[];
	milestone: ApiMilestone | null | undefined;
}

/** The outcome of one issue in an edit. */
type EditItem =
	| { number: number; changed: boolean; added?: string[]; removed?: string[] }
	| { number: number; error: ReturnType<FgjError["toJSON"]>["error"] };

/**
 * Edits one issue: it sends only what differs, so a repeat sends nothing.
 * With `dryRun`, it predicts the result and sends nothing.
 */
async function editOne(
	input: EditInput,
	plan: EditPlan,
	ref: IssueRef,
	api: WriteApi,
	target: Target,
): Promise<Extract<EditItem, { changed: boolean }>> {
	const path = `/repos/${target.owner}/${target.name}/issues/${ref.number}`;
	const issue = await api.get<ApiIssue>(path);
	const current = issue.labels ?? [];
	const has = (l: { id: number }) => current.some((c) => c.id === l.id);
	const toAdd = plan.add.filter((l) => !has(l));
	const toRemove = plan.remove.filter(has);
	const milestone =
		plan.milestone === undefined ? undefined : (plan.milestone?.id ?? null);
	const patch = {
		...(input.title !== undefined && input.title !== issue.title
			? { title: input.title }
			: {}),
		...(input.body !== undefined && input.body !== (issue.body ?? "")
			? { body: input.body }
			: {}),
		// The server reads 0 as no milestone, and ignores null.
		...(milestone !== undefined && milestone !== (issue.milestone?.id ?? null)
			? { milestone: milestone ?? 0 }
			: {}),
	};
	const changed =
		Object.keys(patch).length > 0 || toAdd.length > 0 || toRemove.length > 0;
	const names = (list: readonly { name: string }[], key: string) =>
		list.length > 0 ? { [key]: list.map((l) => l.name) } : {};
	if (input.dryRun) {
		if (Object.keys(patch).length > 0) api.assertSendable(patch);
		// The server drops the other label of an added exclusive scope.
		const scopes = new Set(toAdd.map(scopeOf).filter(Boolean));
		const swapped = current.filter((c) => {
			const full = plan.all.find((l) => l.id === c.id);
			return (
				full !== undefined &&
				!toAdd.some((l) => l.id === c.id) &&
				scopes.has(scopeOf(full))
			);
		});
		const dropped = [
			...new Map(
				[...toRemove, ...swapped].map((l) => [l.id, l] as const),
			).values(),
		];
		return {
			number: issue.number,
			changed,
			...names(toAdd, "added"),
			...names(dropped, "removed"),
		};
	}
	if (Object.keys(patch).length > 0) {
		await api.send("PATCH", path, patch);
	}
	let after = current;
	for (const label of toRemove) {
		await api.send("DELETE", `${path}/labels/${label.id}`);
		after = after.filter((l) => l.id !== label.id);
	}
	if (toAdd.length > 0) {
		after = await api.send<{ id: number; name: string }[]>(
			"POST",
			`${path}/labels`,
			{ labels: toAdd.map((l) => l.id) },
		);
	}
	return {
		number: issue.number,
		changed,
		...names(
			gained(current, after).map((name) => ({ name })),
			"added",
		),
		...names(
			gained(after, current).map((name) => ({ name })),
			"removed",
		),
	};
}

/**
 * `fgj write issue edit <issue...>`: changes the title, the body, the labels,
 * or the milestone. The labels and the milestone apply to each issue; the
 * title and the body need one issue. Only what differs is sent.
 */
export const issueEdit: WriteVerb<EditInput> = {
	risk: "write",
	noun: "issue",
	action: "edit",
	summary:
		"Change the title, body, labels, or milestone of one or many issues. What is already so returns changed:false.",
	notes: [
		"--body-file replaces the whole body. To change part of it, read it whole first with issue get --body-max 20000.",
		"Adding an exclusive label, such as priority/p1, removes the other label of its scope; removed shows it.",
		"Label names match without case. An archived label can be removed, not added.",
		"--milestone takes a title or an id; none removes the milestone. A closed milestone can be set.",
		"--milestone and the label flags apply to each issue. --title and --body-file need one issue. Two or more issues return {changed, items}: one entry per issue, and a failed issue has error {code, message, hint} and does not stop the others. The exit code is the code of the first failure.",
		"A failed issue can keep part of its change, such as the milestone without a label. A retry is safe: it sends only what still differs.",
	],
	args: [
		{
			name: "issue...",
			description: `Issue or pull request numbers, or their URLs, at most ${GET_MAX}.`,
		},
	],
	flags: [
		TITLE_FLAG,
		OPTIONAL_BODY_FILE_FLAG,
		ADD_LABEL_FLAG,
		{
			name: "remove-label",
			kind: "string",
			value: "a,b",
			description: "Comma list of label names to take off.",
		},
		MILESTONE_FLAG,
		DRY_RUN_FLAG,
		REPO_FLAG,
	],
	output:
		"One issue: {changed, number, added, removed}; added and removed list label names, only when not empty. Many: {changed, items:[{number, changed, added, removed} or {number, error}]}. --dry-run adds dry_run and apply.",
	examples: [
		"fgj write issue edit 157 --add-label priority/p1 --remove-label status/needs-triage",
		"fgj write issue edit 157 158 159 --milestone Search",
	],
	prepare(args: ParsedArgs, local: LocalEnv): EditInput {
		const hint = "fgj help issue edit";
		const { refs, remote } = issueRefs(args, GET_MAX, hint);
		const flag = args.flags["body-file"];
		const input = {
			refs,
			...(remote ? { remote } : {}),
			single: refs.length === 1,
			title: titleFlag(args, hint, false),
			body: flag === undefined ? undefined : readBodyFile(flag, local, hint),
			add: labelFlag(args, "add-label", hint),
			remove: labelFlag(args, "remove-label", hint),
			milestone: milestoneFlag(args, hint),
			dryRun: args.flags["dry-run"] === true,
		};
		if (
			input.title === undefined &&
			input.body === undefined &&
			input.add.length === 0 &&
			input.remove.length === 0 &&
			input.milestone === undefined
		) {
			throw new FgjError(
				"usage",
				"Nothing to change. Give --title, --body-file, --add-label, --remove-label, or --milestone.",
				hint,
			);
		}
		if (
			refs.length > 1 &&
			(input.title !== undefined || input.body !== undefined)
		) {
			throw new FgjError(
				"usage",
				`--title and --body-file change one issue, got ${refs.length}. Edit each issue in its own call.`,
				hint,
			);
		}
		const both = input.add.filter((a) =>
			input.remove.some((r) => r.toLowerCase() === a.toLowerCase()),
		);
		if (both.length > 0) {
			throw new FgjError(
				"usage",
				`${both.join(", ")} is in both --add-label and --remove-label.`,
				hint,
			);
		}
		return input;
	},
	remoteOf(input) {
		return input.remote;
	},
	async run(input, ctx) {
		const { target, api, commandWith, commandFor } = ctx;
		const hint = "fgj help issue edit";
		// Names resolve once, before any change, so a bad name changes nothing.
		const plan: EditPlan = {
			all: [],
			add: [],
			remove: [],
			milestone: undefined,
		};
		if (input.add.length > 0 || input.remove.length > 0) {
			plan.all = await repoLabels(api, target);
			const listHint = commandFor("read label list", []);
			plan.add = labelsToAdd(plan.all, input.add, hint, listHint);
			plan.remove = resolveLabels(plan.all, input.remove, hint, {
				archived: true,
				listHint,
			});
		}
		plan.milestone = await wantedMilestone(input.milestone, ctx, hint);
		const unique = [...new Map(input.refs.map((r) => [r.number, r])).values()];
		const one = async (ref: IssueRef): Promise<EditItem> => {
			try {
				return await editOne(input, plan, ref, api, target);
			} catch (err) {
				if (!(err instanceof FgjError)) throw err;
				const error =
					err.code === "not_found" && !input.single
						? new FgjError(
								"not_found",
								`Issue ${ref.number} does not exist in ${target.owner}/${target.name}.`,
								hint,
							)
						: err.hint === "fgj help" && !input.single
							? new FgjError(err.code, err.message, hint)
							: err;
				if (input.single) throw error;
				return { number: ref.number, error: error.toJSON().error };
			}
		};
		// One at a time, so the result order is the order of the changes.
		const items: EditItem[] = [];
		for (const ref of unique) items.push(await one(ref));
		const apply = commandWith(
			{ "dry-run": undefined },
			input.refs.map((r) => r.canonical),
		);
		if (input.single) {
			const item = items[0] as Extract<EditItem, { changed: boolean }>;
			const { changed, ...rest } = item;
			const result = { changed, ...rest };
			return input.dryRun ? { dry_run: true, ...result, apply } : result;
		}
		const failed = items.find(
			(i): i is Extract<EditItem, { error: unknown }> => "error" in i,
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

interface StateInput {
	refs: IssueRef[];
	remote?: IssueRef["remote"];
	single: boolean;
	dryRun: boolean;
}

/** The outcome of one issue in a close or reopen. */
type StateItem =
	| { number: number; changed: boolean }
	| { number: number; error: ReturnType<FgjError["toJSON"]>["error"] };

/**
 * Builds `issue close` or `issue reopen`: sets the state of one or many
 * issues. Each issue that already has the state returns changed:false.
 */
function stateVerb(
	action: "close" | "reopen",
	state: "closed" | "open",
): WriteVerb<StateInput> {
	const hint = `fgj help issue ${action}`;
	return {
		risk: "write",
		noun: "issue",
		action,
		summary: `${action === "close" ? "Close" : "Reopen"} one or many issues. One already ${state} returns changed:false.`,
		notes: [
			"One issue returns {changed, number}. Two or more return {changed, items}: one entry per issue, in the order given.",
			"A failure on one issue does not stop the others: its entry has error {code, message, hint}, and the exit code is the code of the first failure. A retry is safe.",
			...(action === "close"
				? [
						"An issue with open dependencies cannot close (conflict); the hint reads them.",
					]
				: []),
		],
		args: [
			{
				name: "issue...",
				description: `Issue or pull request numbers, or their URLs, at most ${GET_MAX}.`,
			},
		],
		flags: [DRY_RUN_FLAG, REPO_FLAG],
		output:
			"One issue: {changed, number}. Many: {changed, items:[{number, changed} or {number, error}]}; changed is true when any issue changed. --dry-run adds dry_run and apply.",
		examples: [
			`fgj write issue ${action} 157`,
			`fgj write issue ${action} 157 158`,
		],
		prepare(args: ParsedArgs): StateInput {
			const { refs, remote } = issueRefs(args, GET_MAX, hint);
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
			// The issues this call closes, in order, for the dry-run prediction.
			const closing = new Set<number>();
			const one = async (ref: IssueRef): Promise<StateItem> => {
				const path = `/repos/${target.owner}/${target.name}/issues/${ref.number}`;
				try {
					const issue = await api.get<ApiIssue>(path);
					const changed = issue.state !== state;
					if (changed && input.dryRun && action === "close") {
						// Predict the server's refusal, so the plan matches the real run.
						const deps = await linkedIssues(
							api,
							target,
							ref.number,
							"dependencies",
						);
						// An open dependency that this call closes first does not block.
						const blocking = deps.some(
							(d) =>
								d.state === "open" &&
								!(closing.has(d.number) && linkName(d, target) === d.number),
						);
						if (blocking) {
							throw new FgjError(
								"conflict",
								`Conflict: ${OPEN_DEPENDENCIES}`,
								hint,
							);
						}
					}
					if (changed && !input.dryRun) {
						await api.send("PATCH", path, { state });
					}
					if (changed && action === "close") closing.add(ref.number);
					return { number: ref.number, changed };
				} catch (err) {
					if (!(err instanceof FgjError)) throw err;
					const error =
						err.code === "conflict" && /open dependencies/i.test(err.message)
							? new FgjError(
									err.code,
									err.message,
									commandFor("read issue get", [ref.canonical], {
										fields: "number,depends_on",
									}),
								)
							: err.code === "not_found"
								? new FgjError(
										"not_found",
										`Issue ${ref.number} does not exist in ${target.owner}/${target.name}.`,
										hint,
									)
								: err.hint === "fgj help"
									? new FgjError(err.code, err.message, hint)
									: err;
					if (input.single) throw error;
					return { number: ref.number, error: error.toJSON().error };
				}
			};
			// One at a time, so the result order is the order of the changes.
			const items: StateItem[] = [];
			for (const ref of unique) items.push(await one(ref));
			const dry = input.dryRun
				? {
						dry_run: true,
						apply: commandWith(
							{ "dry-run": undefined },
							input.refs.map((r) => r.canonical),
						),
					}
				: {};
			if (input.single) return { ...(items[0] as StateItem), ...dry };
			const failed = items.find(
				(i): i is Extract<StateItem, { error: unknown }> => "error" in i,
			);
			return {
				...(input.dryRun ? { dry_run: true } : {}),
				changed: items.some((i) => "changed" in i && i.changed),
				items,
				...(input.dryRun ? { apply: dry.apply } : {}),
				...(failed ? { [FAILED]: failed.error.code } : {}),
			};
		},
	};
}

/** `fgj write issue close <issue...>`. */
export const issueClose = stateVerb("close", "closed");

/** `fgj write issue reopen <issue...>`. */
export const issueReopen = stateVerb("reopen", "open");

import { FgjError } from "../core/errors.ts";
import {
	LIST_LIMIT_DEFAULT,
	LIST_LIMIT_MAX,
	page,
	pick,
	selectFields,
} from "../core/output.ts";
import type {
	LocalEnv,
	ParsedArgs,
	ReadVerb,
	WriteVerb,
} from "../core/verb.ts";
import type { ReadApi } from "../forgejo/client.ts";
import type { Target } from "../forgejo/target.ts";
import {
	DRY_RUN_FLAG,
	mapLimit,
	REPO_FLAG,
	rangeFlag,
	readTextFile,
} from "./common.ts";

/** A Forgejo milestone, reduced to the keys fgj reads. */
export interface ApiMilestone {
	id: number;
	title: string;
	description: string;
	state: "open" | "closed";
	open_issues: number;
	closed_issues: number;
}

/** Forgejo's largest page for milestone lists. */
const MILESTONE_PAGE = 50;

/** The longest milestone title that the Forgejo web form saves. */
export const MILESTONE_TITLE_MAX = 50;

/** The word that means "no milestone" or "no description" in a flag. */
const NONE = "none";

/**
 * Reads every milestone of a repository, open and closed, across all pages.
 * The server lists both states when no state is sent, so fgj always sends one.
 *
 * @param api - A client that can send GET.
 * @param target - The repository.
 * @returns The milestones in the server's order.
 * @throws {FgjError} not_found when the repository does not exist.
 * @example
 * const milestones = await repoMilestones(api, target);
 */
export async function repoMilestones(
	api: Pick<ReadApi, "list">,
	target: Target,
): Promise<ApiMilestone[]> {
	const path = `/repos/${target.owner}/${target.name}/milestones`;
	const all: ApiMilestone[] = [];
	// Stop at the total, not at a short page: a server can page below 50.
	for (let p = 1; ; p++) {
		const { items, total } = await api.list<ApiMilestone>(path, {
			state: "all",
			limit: MILESTONE_PAGE,
			page: p,
		});
		all.push(...items);
		if (items.length === 0 || all.length >= total) return all;
	}
}

/**
 * Finds the milestone that an argument names: the milestone with exactly that
 * title, else the one whose title matches without case, else, for digits, the
 * milestone with that id. Closed milestones count.
 *
 * @param milestones - Every milestone of the repository, from {@link repoMilestones}.
 * @param arg - The title or id that the caller wrote.
 * @param hint - The help command for a title that matches several milestones.
 * @param listHint - The milestone list command, with the call's `--repo`.
 * @returns The milestone.
 * @throws {FgjError} usage when a title matches several milestones, and
 *   not_found when nothing matches.
 * @example
 * resolveMilestone(milestones, "search", "fgj help issue edit", "fgj read milestone list --state all");
 * // { id: 4, title: "Search", … }
 */
export function resolveMilestone(
	milestones: readonly ApiMilestone[],
	arg: string,
	hint: string,
	listHint: string,
): ApiMilestone {
	const exact = milestones.filter((m) => m.title === arg);
	const loose = milestones.filter(
		(m) => m.title.toLowerCase() === arg.toLowerCase(),
	);
	const matches = exact.length > 0 ? exact : loose;
	if (matches.length > 1) {
		throw new FgjError(
			"usage",
			`The milestone "${arg}" matches ${matches.length} milestones, ids ${matches.map((m) => m.id).join(", ")}. Name one by its id.`,
			hint,
		);
	}
	const byId = /^[1-9]\d{0,14}$/.test(arg)
		? milestones.find((m) => m.id === Number(arg))
		: undefined;
	const found = matches[0] ?? byId;
	if (!found) {
		throw new FgjError(
			"not_found",
			`No milestone has the title or id "${arg}" in this repository.`,
			listHint,
		);
	}
	return found;
}

/**
 * Reads the `--milestone` flag of an issue verb. `none` means no milestone.
 *
 * @param args - The parsed arguments.
 * @param hint - The help command for the error.
 * @returns The title or id, `null` for `none`, or `undefined` when the flag is absent.
 * @throws {FgjError} A usage error for a blank value.
 * @example
 * milestoneFlag({ positionals: [], flags: { milestone: "None" } }, "fgj help issue edit"); // null
 */
export function milestoneFlag(
	args: ParsedArgs,
	hint: string,
): string | null | undefined {
	const raw = args.flags.milestone;
	if (raw === undefined) return undefined;
	const value = String(raw).trim();
	if (value === "") {
		throw new FgjError(
			"usage",
			"--milestone needs a title or an id, or none to remove it.",
			hint,
		);
	}
	return value.toLowerCase() === NONE ? null : value;
}

/** The `--milestone` flag of `issue create` and `issue edit`. */
export const MILESTONE_FLAG = {
	name: "milestone",
	kind: "string",
	value: "TITLE|ID",
	description: "The milestone, by title or id. none removes it.",
} as const;

/** Reads `--title`: trimmed, one line, 1 to 50 characters, and not `none`. */
function titleFlag(
	args: ParsedArgs,
	hint: string,
	required: boolean,
): string | undefined {
	const raw = args.flags.title;
	if (raw === undefined) {
		if (required) throw new FgjError("usage", "Missing --title TEXT.", hint);
		return undefined;
	}
	const title = String(raw).trim();
	if (
		title === "" ||
		/[\r\n]/.test(title) ||
		Array.from(title).length > MILESTONE_TITLE_MAX
	) {
		throw new FgjError(
			"usage",
			`--title needs 1 to ${MILESTONE_TITLE_MAX} characters on one line, as the Forgejo web form saves.`,
			hint,
		);
	}
	if (title.toLowerCase() === NONE) {
		throw new FgjError(
			"usage",
			`A milestone cannot have the title "${title}": --milestone none means no milestone.`,
			hint,
		);
	}
	return title;
}

/**
 * Reads `--description`: trimmed and one line. On edit, `none` clears it; on
 * create, the word `none` is refused, so that no description reads as a clear.
 */
function descriptionFlag(
	args: ParsedArgs,
	hint: string,
	clears: boolean,
): string | undefined {
	const raw = args.flags.description;
	if (raw === undefined) return undefined;
	const description = String(raw).trim();
	if (/[\r\n]/.test(description)) {
		throw new FgjError("usage", "--description needs one line.", hint);
	}
	if (description.toLowerCase() === NONE) {
		if (clears) return "";
		throw new FgjError(
			"usage",
			"A description cannot be the word none: milestone edit --description none clears a description. Leave the flag out for no description.",
			hint,
		);
	}
	return description;
}

/**
 * Refuses a title of digits that is the id of another milestone: a title wins
 * over an id, so the new title would hide that milestone from its id.
 */
function idClash(
	all: readonly ApiMilestone[],
	title: string,
	self: number | undefined,
	listHint: string,
): void {
	const hidden = /^\d+$/.test(title)
		? all.find((m) => m.id !== self && String(m.id) === title)
		: undefined;
	if (hidden) {
		throw new FgjError(
			"conflict",
			`The title "${title}" is the id of the milestone "${hidden.title}". A title wins over an id, so it would hide that milestone. Choose another title.`,
			listHint,
		);
	}
}

/** Reads the one milestone argument of edit, close, and reopen. */
function milestoneArg(args: ParsedArgs, hint: string): string {
	if (args.positionals.length !== 1) {
		throw new FgjError(
			"usage",
			args.positionals.length === 0
				? "Missing the milestone: its title or id. Quote a title with spaces."
				: `Expected one milestone, got ${args.positionals.length}: ${args.positionals.join(" ")}. Quote a title with spaces.`,
			hint,
		);
	}
	return (args.positionals[0] as string).trim();
}

const LIST_FIELDS = {
	all: ["id", "title", "state", "open_issues", "closed_issues", "description"],
	default: [
		"id",
		"title",
		"state",
		"open_issues",
		"closed_issues",
		"description",
	],
} as const;

const STATES = ["open", "closed", "all"] as const;

interface ListInput {
	state: (typeof STATES)[number];
	fields: readonly string[];
	limit: number;
	offset: number;
}

/** The most count requests that one list runs at the same time. */
const COUNT_PARALLEL = 8;

/**
 * The value of the issue filter `milestones` that names only this milestone.
 * The filter splits at commas and reads a title first and an id second, so an
 * id works unless another milestone has it as its title. Then the title works
 * when no other milestone has it, without case, and it has no comma.
 *
 * @returns The filter value, or `undefined` when no value names only this milestone.
 */
function filterValue(
	milestone: ApiMilestone,
	all: readonly ApiMilestone[],
): string | undefined {
	const others = all.filter((o) => o.id !== milestone.id);
	const id = String(milestone.id);
	if (!others.some((o) => o.title.trim() === id)) return id;
	const title = milestone.title;
	const lower = title.toLowerCase();
	return title !== "" &&
		title === title.trim() &&
		!title.includes(",") &&
		!others.some((o) => o.title.trim().toLowerCase() === lower)
		? title
		: undefined;
}

/**
 * Counts a milestone's issues and pull requests in one state with the issue
 * filter, which is exact right after an edit. The server's own counts change
 * about a second later. The filter ignores a value that names no milestone,
 * so fgj checks the milestone of the first issue.
 *
 * @returns The count, or `undefined` when the filter did not mean this milestone.
 */
async function countIssues(
	api: Pick<ReadApi, "list">,
	target: Target,
	milestone: ApiMilestone,
	filter: string,
	state: "open" | "closed",
): Promise<number | undefined> {
	const { items, total } = await api.list<{
		milestone: { id: number } | null;
	}>(`/repos/${target.owner}/${target.name}/issues`, {
		state,
		milestones: filter,
		limit: 1,
		page: 1,
	});
	const first = items[0];
	if (first && first.milestone?.id !== milestone.id) return undefined;
	return total;
}

/**
 * The open and closed counts of each milestone. A milestone that no filter
 * value names alone keeps the server's counts.
 */
async function issueCounts(
	api: Pick<ReadApi, "list">,
	target: Target,
	shown: readonly ApiMilestone[],
	all: readonly ApiMilestone[],
): Promise<Map<number, [number, number]>> {
	const counts = await mapLimit(shown, COUNT_PARALLEL, async (m) => {
		const server: [number, number] = [m.open_issues, m.closed_issues];
		const filter = filterValue(m, all);
		if (filter === undefined) return server;
		const open = await countIssues(api, target, m, filter, "open");
		const closed = await countIssues(api, target, m, filter, "closed");
		return open === undefined || closed === undefined
			? server
			: ([open, closed] as [number, number]);
	});
	return new Map(shown.map((m, i) => [m.id, counts[i] as [number, number]]));
}

/** `fgj read milestone list`: the repository's milestones, with their issue counts. */
export const milestoneList: ReadVerb<ListInput> = {
	risk: "read",
	noun: "milestone",
	action: "list",
	summary:
		"List the repository's milestones with their ids and open and closed issue counts.",
	notes: [
		"fgj counts the issues itself, so the counts are exact right after an edit. Forgejo's own counts change about a second later. The counts include pull requests.",
		"In rare cases a milestone keeps Forgejo's counts: when its id is the title of another milestone, and its own title is shared, has a comma, or has spaces at either end.",
		"The id is the number in the milestone's web URL. Use it to name a milestone whose title another milestone shares.",
		"--fields without the counts skips the count requests.",
	],
	args: [],
	flags: [
		{
			name: "state",
			kind: "string",
			value: "open|closed|all",
			description: "Which milestones to list (default open).",
		},
		{
			name: "fields",
			kind: "fields",
			value: "a,b",
			description: "Comma list of fields. Alone, it lists the fields.",
		},
		{
			name: "limit",
			kind: "int",
			description: `Most milestones per page (1-${LIST_LIMIT_MAX}, default ${LIST_LIMIT_DEFAULT}).`,
		},
		{
			name: "offset",
			kind: "int",
			description: "Index of the first milestone. `next` sets it for you.",
		},
		REPO_FLAG,
	],
	fields: LIST_FIELDS,
	output:
		"{items:[{id, title, state, open_issues, closed_issues, description}], total, next}. description only when not empty. next is the exact command for the next page, or null.",
	examples: [
		"fgj read milestone list",
		"fgj read milestone list --state all --fields id,title,state",
	],
	prepare(args: ParsedArgs): ListInput {
		const hint = "fgj help milestone list";
		const state = args.flags.state ?? "open";
		if (!STATES.includes(state as ListInput["state"])) {
			throw new FgjError(
				"usage",
				`--state must be open, closed, or all, got "${String(state)}".`,
				hint,
			);
		}
		return {
			state: state as ListInput["state"],
			fields: selectFields(args.flags.fields, LIST_FIELDS, hint),
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
	async run(input, { target, api, commandWith }) {
		const all = await repoMilestones(api, target);
		const matching = all.filter(
			(m) => input.state === "all" || m.state === input.state,
		);
		const window = matching.slice(input.offset, input.offset + input.limit);
		const counted =
			input.fields.includes("open_issues") ||
			input.fields.includes("closed_issues");
		const counts = counted
			? await issueCounts(api, target, window, all)
			: new Map<number, [number, number]>();
		const items = window.map((m) =>
			pick(
				{
					id: m.id,
					title: m.title,
					state: m.state,
					open_issues: counts.get(m.id)?.[0],
					closed_issues: counts.get(m.id)?.[1],
					description: m.description || undefined,
				},
				input.fields,
			),
		);
		const next = (at: number) => commandWith({ offset: at });
		const shown = page(items, 0, items.length, (end) =>
			next(input.offset + end),
		);
		const end = input.offset + shown.items.length;
		return {
			items: shown.items,
			total: matching.length,
			next: shown.next ?? (end < matching.length ? next(end) : null),
		};
	},
};

interface CreateInput {
	title: string;
	description: string;
	dryRun: boolean;
}

/**
 * `fgj write milestone create --title TEXT`: adds an open milestone with no
 * deadline. Forgejo does not check that titles are unique, so fgj reads every
 * milestone first: the same open milestone returns changed:false, and any other
 * milestone with the title is a conflict that fgj does not change.
 */
export const milestoneCreate: WriteVerb<CreateInput> = {
	risk: "write",
	noun: "milestone",
	action: "create",
	summary:
		"Add an open milestone with no deadline. The same milestone again returns changed:false.",
	notes: [
		"Titles match without case. A milestone with the title and another description, a closed one, or two that share it fail with conflict; fgj never edits them.",
		"Forgejo does not check that titles are unique. fgj reads every milestone first, but two calls at the same time can still make two milestones.",
		"The title cannot be none, the word that --milestone none uses for no milestone, or the id of another milestone, which it would hide. A title of digits can still hide a milestone that gets that id later.",
		"The result is {changed, id, title}; title is the stored spelling.",
	],
	args: [],
	flags: [
		{
			name: "title",
			kind: "string",
			value: "TEXT",
			description: `The title (1-${MILESTONE_TITLE_MAX} characters). Quote it.`,
			required: true,
		},
		{
			name: "description",
			kind: "string",
			value: "TEXT",
			description: "One line. Quote it. Default: empty.",
		},
		DRY_RUN_FLAG,
		REPO_FLAG,
	],
	output:
		"{changed, id, title}. changed:false means the open milestone already existed with this description. --dry-run: {dry_run, changed, id, title, apply}; id only when it exists.",
	examples: [
		"fgj write milestone create --title Search --description 'Find any note in two seconds'",
		"fgj write milestone create --title 'Release 2' --dry-run",
	],
	prepare(args: ParsedArgs): CreateInput {
		const hint = "fgj help milestone create";
		if (args.positionals.length > 0) {
			throw new FgjError(
				"usage",
				`milestone create takes no argument, got ${args.positionals.join(" ")}. Give the title with --title.`,
				hint,
			);
		}
		return {
			title: titleFlag(args, hint, true) as string,
			description: descriptionFlag(args, hint, false) ?? "",
			dryRun: args.flags["dry-run"] === true,
		};
	},
	async run(input, { target, api, commandWith, commandFor }) {
		const listHint = commandFor("read milestone list", [], { state: "all" });
		const all = await repoMilestones(api, target);
		const same = all.filter(
			(m) => m.title.toLowerCase() === input.title.toLowerCase(),
		);
		if (same.length === 0) idClash(all, input.title, undefined, listHint);
		if (same.length > 1) {
			throw new FgjError(
				"conflict",
				`The title "${input.title}" matches ${same.length} milestones, ids ${same.map((m) => m.id).join(", ")}. fgj does not pick one.`,
				listHint,
			);
		}
		const found = same[0];
		if (found?.state === "closed") {
			throw new FgjError(
				"conflict",
				`The milestone "${found.title}" (id ${found.id}) exists and is closed. fgj does not reopen it in a create.`,
				commandFor("write milestone reopen", [String(found.id)]),
			);
		}
		if (found && (found.description ?? "") !== input.description) {
			throw new FgjError(
				"conflict",
				`The milestone "${found.title}" (id ${found.id}) exists with the description "${found.description ?? ""}". fgj does not change an existing milestone.`,
				listHint,
			);
		}
		const send = { title: input.title, description: input.description };
		if (input.dryRun) {
			if (!found) api.assertSendable(send);
			return {
				dry_run: true,
				changed: !found,
				...(found ? { id: found.id } : {}),
				title: found?.title ?? input.title,
				apply: commandWith({ "dry-run": undefined }),
			};
		}
		if (found) return { changed: false, id: found.id, title: found.title };
		const created = await api.send<ApiMilestone>(
			"POST",
			`/repos/${target.owner}/${target.name}/milestones`,
			send,
		);
		return { changed: true, id: created.id, title: created.title };
	},
};

interface EditInput {
	milestone: string;
	title: string | undefined;
	description: string | undefined;
	dryRun: boolean;
}

/**
 * `fgj write milestone edit <milestone>`: changes the title or the description.
 * Only what differs is sent, so a repeat sends nothing.
 */
export const milestoneEdit: WriteVerb<EditInput> = {
	risk: "write",
	noun: "milestone",
	action: "edit",
	summary:
		"Change a milestone's title or description. What is already so returns changed:false.",
	notes: [
		"A milestone is its exact title, else its title without case, else its id. A title that two milestones share fails with usage; name one by its id.",
		"--description none clears the description. --description-file sends exact UTF-8 text, including line endings. An empty file clears it; a file containing none saves that text.",
		"Use either --description or --description-file, not both.",
		"A new title that another milestone has, without case, fails with conflict.",
	],
	args: [{ name: "milestone", description: "The milestone's title or id." }],
	flags: [
		{
			name: "title",
			kind: "string",
			value: "TEXT",
			description: `The new title (1-${MILESTONE_TITLE_MAX} characters). Quote it.`,
		},
		{
			name: "description",
			kind: "string",
			value: "TEXT",
			description: "The new description, one line. none clears it.",
		},
		{
			name: "description-file",
			kind: "string",
			value: "PATH",
			description:
				"Path to exact UTF-8 description text, at most 1 MiB. An empty file clears it.",
		},
		DRY_RUN_FLAG,
		REPO_FLAG,
	],
	output: "{changed, id}. --dry-run adds dry_run and apply.",
	examples: [
		"fgj write milestone edit Search --title 'Search v2'",
		"fgj write milestone edit 7 --description none",
		"fgj write milestone edit 7 --description-file /tmp/description.md",
	],
	prepare(args: ParsedArgs, local: LocalEnv): EditInput {
		const hint = "fgj help milestone edit";
		if (
			args.flags.description !== undefined &&
			args.flags["description-file"] !== undefined
		) {
			throw new FgjError(
				"usage",
				"Use either --description or --description-file, not both.",
				hint,
			);
		}
		const input = {
			milestone: milestoneArg(args, hint),
			title: titleFlag(args, hint, false),
			description:
				args.flags["description-file"] === undefined
					? descriptionFlag(args, hint, true)
					: readTextFile(args.flags["description-file"], local, hint, {
							kind: "description file",
							missing: "Missing --description-file PATH.",
							allowEmpty: true,
						}).text,
			dryRun: args.flags["dry-run"] === true,
		};
		if (input.title === undefined && input.description === undefined) {
			throw new FgjError(
				"usage",
				"Nothing to change. Give --title, --description, or --description-file.",
				hint,
			);
		}
		return input;
	},
	async run(input, { target, api, commandWith, commandFor }) {
		const listHint = commandFor("read milestone list", [], { state: "all" });
		const all = await repoMilestones(api, target);
		const m = resolveMilestone(
			all,
			input.milestone,
			"fgj help milestone edit",
			listHint,
		);
		const title = input.title;
		if (title !== undefined && title !== m.title) {
			const taken = all.find(
				(o) => o.id !== m.id && o.title.toLowerCase() === title.toLowerCase(),
			);
			if (taken) {
				throw new FgjError(
					"conflict",
					`The milestone "${taken.title}" (id ${taken.id}) has that title. fgj does not make two milestones with one title.`,
					listHint,
				);
			}
			idClash(all, title, m.id, listHint);
		}
		const patch = {
			...(title !== undefined && title !== m.title ? { title } : {}),
			...(input.description !== undefined &&
			input.description !== (m.description ?? "")
				? { description: input.description }
				: {}),
		};
		const changed = Object.keys(patch).length > 0;
		if (input.dryRun) {
			if (changed) api.assertSendable(patch);
			return {
				dry_run: true,
				changed,
				id: m.id,
				apply: commandWith({ "dry-run": undefined }),
			};
		}
		if (changed) {
			await api.send(
				"PATCH",
				`/repos/${target.owner}/${target.name}/milestones/${m.id}`,
				patch,
			);
		}
		return { changed, id: m.id };
	},
};

interface StateInput {
	milestone: string;
	dryRun: boolean;
}

/**
 * Builds `milestone close` or `milestone reopen`. A milestone that already has
 * the state returns changed:false and sends nothing: the server would still
 * change its update time.
 */
function stateVerb(
	action: "close" | "reopen",
	state: "closed" | "open",
): WriteVerb<StateInput> {
	const hint = `fgj help milestone ${action}`;
	return {
		risk: "write",
		noun: "milestone",
		action,
		summary: `${action === "close" ? "Close" : "Reopen"} a milestone. One already ${state} returns changed:false.`,
		notes: [
			"A milestone is its exact title, else its title without case, else its id.",
			...(action === "close"
				? [
						"Its issues keep the milestone, and an issue can still be set to it.",
					]
				: []),
		],
		args: [{ name: "milestone", description: "The milestone's title or id." }],
		flags: [DRY_RUN_FLAG, REPO_FLAG],
		output: "{changed, id}. --dry-run adds dry_run and apply.",
		examples: [
			`fgj write milestone ${action} Search`,
			`fgj write milestone ${action} 7`,
		],
		prepare(args: ParsedArgs): StateInput {
			return {
				milestone: milestoneArg(args, hint),
				dryRun: args.flags["dry-run"] === true,
			};
		},
		async run(input, { target, api, commandWith, commandFor }) {
			const m = resolveMilestone(
				await repoMilestones(api, target),
				input.milestone,
				hint,
				commandFor("read milestone list", [], { state: "all" }),
			);
			const changed = m.state !== state;
			if (input.dryRun) {
				return {
					dry_run: true,
					changed,
					id: m.id,
					apply: commandWith({ "dry-run": undefined }),
				};
			}
			if (changed) {
				await api.send(
					"PATCH",
					`/repos/${target.owner}/${target.name}/milestones/${m.id}`,
					{ state },
				);
			}
			return { changed, id: m.id };
		},
	};
}

/** `fgj write milestone close <milestone>`. */
export const milestoneClose = stateVerb("close", "closed");

/** `fgj write milestone reopen <milestone>`. */
export const milestoneReopen = stateVerb("reopen", "open");

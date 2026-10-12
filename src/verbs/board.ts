import { FgjError } from "../core/errors.ts";
import { BODY_MAX_LIMIT, OUTPUT_CAP } from "../core/output.ts";
import {
	FAILED,
	type FlagSpec,
	type ParsedArgs,
	type ReadVerb,
	type VerbContext,
	type WriteVerb,
} from "../core/verb.ts";
import {
	type Board,
	type Column,
	type ProjectRef,
	parseBoard,
	parseProjectList,
} from "../forgejo/board.ts";
import type { ReadApi } from "../forgejo/client.ts";
import type { WebReader, WebWriter } from "../forgejo/web.ts";
import {
	assertRepo,
	DRY_RUN_FLAG,
	type IssueRef,
	issueRefs,
	REPO_FLAG,
	readMany,
} from "./common.ts";

/** What the board helpers use of a read or write verb's context. */
type BoardCtx = Pick<
	VerbContext<ReadApi>,
	"target" | "commandWith" | "commandFor"
> & {
	api: Pick<ReadApi, "get">;
};

/** The most issues that one `board card`, `board add`, or `board move` takes. */
const CARD_MAX = 50;

/** The most project list pages that fgj reads, at 20 projects each by default. */
const LIST_PAGES_MAX = 50;

/** The most project names that an error lists. */
const NAMES_MAX = 20;

const PROJECT_FLAG: FlagSpec = {
	name: "project",
	kind: "string",
	value: "N|TITLE",
	description:
		"The project number, or its title (case does not matter; a title of digits only reads as a number). Optional when the repository has one open project.",
};

const LOGIN_NOTE =
	"Board verbs use the profile's web login, because Forgejo has no board API. When it expires, the error asks a human to run fgj auth web; an agent cannot run it.";

/** The repository's path on the host, as page links write it, with any base URL prefix. */
function linkBase(ctx: BoardCtx): string {
	const prefix = new URL(ctx.target.baseUrl).pathname.replace(/\/$/, "");
	return `${prefix}/${ctx.target.owner}/${ctx.target.name}`;
}

/** `4 (Plan), 5 (Ops)`, with at most {@link NAMES_MAX} names. */
function projectNames(projects: readonly ProjectRef[]): string {
	const shown = projects
		.slice(0, NAMES_MAX)
		.map((p) => `${p.number} (${p.title})`)
		.join(", ");
	const more = projects.length - NAMES_MAX;
	return more > 0 ? `${shown}, and ${more} more` : shown;
}

/**
 * Fails with not_found when the repository's projects page does not exist:
 * the repository is missing, its Projects unit is off, or the account cannot
 * read it.
 */
async function projectsOff(ctx: BoardCtx, hint: string): Promise<never> {
	await assertRepo(ctx.api, ctx.target, hint);
	throw new FgjError(
		"not_found",
		`${ctx.target.owner}/${ctx.target.name} has no projects page: its Projects unit is off, or this account cannot read it.`,
		hint,
	);
}

/**
 * Every open or closed project of the repository, or with `owner` of its
 * owner (user or organization), or those whose title holds `q`. An owner with
 * no projects page has none. A repository with no projects page fails with
 * not_found, or with `offIsNull` gives `null`.
 */
async function listProjects(
	web: WebReader,
	ctx: BoardCtx,
	hint: string,
	state: "open" | "closed",
	q?: string,
	owner = false,
	offIsNull = false,
): Promise<ProjectRef[] | null> {
	const repo = owner
		? `/${ctx.target.owner}/-`
		: `/${ctx.target.owner}/${ctx.target.name}`;
	const prefix = new URL(ctx.target.baseUrl).pathname.replace(/\/$/, "");
	const all: ProjectRef[] = [];
	for (let page = 1; page <= LIST_PAGES_MAX; page++) {
		const query = new URLSearchParams({
			state,
			...(q === undefined ? {} : { q }),
			...(page > 1 ? { page: String(page) } : {}),
		});
		const got = await web.page(`${repo}/projects?${query}`);
		if (!got) {
			if (owner) return all;
			if (!offIsNull) return projectsOff(ctx, hint);
			await assertRepo(ctx.api, ctx.target, hint);
			return null;
		}
		const list = await parseProjectList(got.html, `${prefix}${repo}`, page);
		all.push(...list.projects);
		if (!list.more) return all;
	}
	throw new FgjError(
		"api",
		`${repo} lists more than ${LIST_PAGES_MAX} pages of projects. Name the project by number.`,
		hint,
	);
}

/**
 * Finds the project that a title names. An exact title wins over a match
 * without case, and an open project wins over a closed one.
 */
async function projectByTitle(
	web: WebReader,
	ctx: BoardCtx,
	hint: string,
	raw: string,
): Promise<ProjectRef[]> {
	const open = (await listProjects(web, ctx, hint, "open", raw)) ?? [];
	const exact = (list: ProjectRef[]) => list.filter((p) => p.title === raw);
	const loose = (list: ProjectRef[]) =>
		list.filter((p) => p.title.toLowerCase() === raw.toLowerCase());
	if (exact(open).length > 0) return exact(open);
	const closed = (await listProjects(web, ctx, hint, "closed", raw)) ?? [];
	for (const found of [exact(closed), loose(open), loose(closed)]) {
		if (found.length > 0) return found;
	}
	return [];
}

/**
 * Reads the project board that `--project` names, or the repository's only
 * open project when it names none.
 */
async function openBoard(
	web: WebReader,
	ctx: BoardCtx,
	raw: string | undefined,
	hint: string,
): Promise<{ number: number; board: Board }> {
	const { owner, name } = ctx.target;
	const repo = `/${owner}/${name}`;
	const slug = `${owner}/${name}`;
	const unknown = async (what: string) => {
		const open = (await listProjects(web, ctx, hint, "open")) ?? [];
		const names =
			open.length > 0 ? ` Open projects: ${projectNames(open)}.` : "";
		return new FgjError(
			"not_found",
			`No project ${what} in ${slug}.${names}`,
			ctx.commandWith({ project: undefined }),
		);
	};
	let number: number;
	if (raw === undefined) {
		const open = (await listProjects(web, ctx, hint, "open")) ?? [];
		const [only] = open;
		if (open.length === 1 && only) {
			number = only.number;
		} else if (open.length === 0) {
			const closed = (await listProjects(web, ctx, hint, "closed")) ?? [];
			const names =
				closed.length > 0
					? ` Closed projects: ${projectNames(closed)}. Name one with --project.`
					: "";
			throw new FgjError(
				"not_found",
				`${slug} has no open project.${names}`,
				hint,
			);
		} else {
			throw new FgjError(
				"usage",
				`${slug} has ${open.length} open projects: ${projectNames(open)}. Name one with --project, by number or title.`,
				hint,
			);
		}
	} else if (/^[1-9]\d{0,14}$/.test(raw)) {
		number = Number(raw);
	} else {
		const matches = await projectByTitle(web, ctx, hint, raw);
		const [first] = matches;
		if (!first) throw await unknown(`"${raw}"`);
		if (matches.length > 1) {
			throw new FgjError(
				"usage",
				`The title "${raw}" names ${matches.length} projects: ${projectNames(matches)}. Name one by number.`,
				hint,
			);
		}
		number = first.number;
	}
	const page = await web.page(`${repo}/projects/${number}`);
	if (!page) throw await unknown(String(number));
	return { number, board: await parseBoard(page.html, linkBase(ctx)) };
}

/** Finds a column: the exact name, else the one name that matches without case. */
function pickColumn(board: Board, raw: string, hint: string): Column {
	const exact = board.columns.find((c) => c.name === raw);
	if (exact) return exact;
	const loose = board.columns.filter(
		(c) => c.name.toLowerCase() === raw.toLowerCase(),
	);
	if (loose.length === 1) return loose[0] as Column;
	const names = board.columns.map((c) => c.name).join(", ");
	throw new FgjError(
		"usage",
		names
			? `No column "${raw}" on ${board.title}. Columns: ${names}.`
			: `No column "${raw}": ${board.title} has no columns.`,
		hint,
	);
}

/** Where the scan found an issue: the board, its path, and the column. */
interface Location {
	/** `/{owner}/{repo}` or `/{owner}/-`, the path of the board's project routes. */
	base: string;
	number: number;
	board: Board;
	column: Column;
}

/**
 * Reads boards until it finds each wanted issue: the repository's open
 * projects, the owner's open projects, then the closed ones of each. The
 * boards are the current truth, and each is read once. A repository with no
 * projects page (the Projects unit is off, or the account cannot read it)
 * gives `repoOff`, and only owner boards count.
 *
 * @returns Where each found issue is, and whether the repository boards were hidden.
 */
async function scanBoards(
	web: WebReader,
	ctx: BoardCtx,
	hint: string,
	wanted: readonly number[],
	skip?: { base: string; number: number },
): Promise<{ found: Map<number, Location>; repoOff: boolean }> {
	const { owner, name } = ctx.target;
	const found = new Map<number, Location>();
	let repoOff = false;
	if (wanted.length === 0) return { found, repoOff };
	const sources = [
		["open", false],
		["open", true],
		["closed", false],
		["closed", true],
	] as const;
	for (const [state, ofOwner] of sources) {
		if (repoOff && !ofOwner) continue;
		const base = ofOwner ? `/${owner}/-` : `/${owner}/${name}`;
		const projects = await listProjects(
			web,
			ctx,
			hint,
			state,
			undefined,
			ofOwner,
			true,
		);
		if (projects === null) repoOff = true;
		for (const p of projects ?? []) {
			if (skip && skip.base === base && skip.number === p.number) continue;
			const page = await web.page(`${base}/projects/${p.number}`);
			// A project deleted since the list was read has no board.
			if (!page) continue;
			const board = await parseBoard(page.html, linkBase(ctx));
			for (const column of board.columns) {
				for (const n of column.issues) {
					if (!found.has(n)) {
						found.set(n, { base, number: p.number, board, column });
					}
				}
			}
			if (wanted.every((n) => found.has(n))) return { found, repoOff };
		}
	}
	return { found, repoOff };
}

/** The error for an issue that no readable board holds, when the repository boards are hidden. */
function hiddenBoards(ctx: BoardCtx, n: number, hint: string): FgjError {
	const { owner, name } = ctx.target;
	return new FgjError(
		"not_found",
		`${owner}/${name} has no projects page: its Projects unit is off, or this account cannot read it. Issue ${n} is on no board of ${owner}, and fgj cannot read the repository's boards.`,
		hint,
	);
}

const PROJECT_TEMPLATES = {
	none: "0",
	"basic-kanban": "1",
	"bug-triage": "2",
} as const;

interface CreateInput {
	name: string;
	template: keyof typeof PROJECT_TEMPLATES;
	dryRun: boolean;
}

/** Finds all full-name matches without an exact-case preference. */
async function creationMatches(
	web: WebReader,
	ctx: BoardCtx,
	state: "open" | "closed",
	name: string,
): Promise<ProjectRef[]> {
	const projects = await listProjects(web, ctx, "fgj help board create", state);
	return (projects ?? []).filter(
		(p) => p.title.toLowerCase() === name.toLowerCase(),
	);
}

/** Reads the saved board before a create or reuse result can report success. */
async function creationResult(
	web: WebReader,
	ctx: BoardCtx,
	project: ProjectRef,
	changed: boolean,
) {
	const path = `/${ctx.target.owner}/${ctx.target.name}/projects/${project.number}`;
	const page = await web.page(path);
	if (!page)
		throw new FgjError(
			"api",
			`Project ${project.number} read-back failed. Creation is not confirmed. Check the project list before another create.`,
			ctx.commandFor("read board list", [], {
				project: String(project.number),
			}),
		);
	const board = await parseBoard(page.html, linkBase(ctx));
	if (board.title !== project.title)
		throw new FgjError(
			"api",
			`Project ${project.number} changed its name during read-back. The result is not confirmed.`,
			"fgj help board create",
		);
	return {
		changed,
		number: project.number,
		...(changed ? { url: `${ctx.target.baseUrl}${path}` } : {}),
		project: board.title,
		columns: board.columns.map((c) => c.name),
	};
}

/** `fgj write board create <name> [--template TYPE]`. */
export const boardCreate: WriteVerb<CreateInput> = {
	risk: "write",
	noun: "board",
	action: "create",
	summary: "Create a repository board, or reuse its unique open name match.",
	notes: [
		"Templates: none, basic-kanban (default), bug-triage. Saved columns come from the server, not a fixed workflow.",
		"One open full-name match, without case, returns changed:false and stays unchanged, even with a different template or closed matches.",
		"Multiple open matches or closed-only matches cause a conflict. Exact case has no preference. fgj never reopens or edits a board.",
		"Creation needs Projects write access, Projects enabled, and an unarchived repository. A successful create returns the saved board and columns.",
		"An uncertain response never reports success or repeats the creation POST. Check the board list before another create.",
		"--dry-run reads only. A create plan names the template; a reuse plan names saved columns. A conflict still fails.",
		LOGIN_NOTE,
	],
	args: [
		{
			name: "name",
			description:
				"The full board name, 1–100 characters and at most 255 UTF-8 bytes. Use valid Unicode with no leading or trailing space. Quote a name with spaces.",
		},
	],
	flags: [
		{
			name: "template",
			kind: "string",
			value: "TYPE",
			description:
				"none, basic-kanban (default), or bug-triage. Reuse ignores this choice.",
		},
		DRY_RUN_FLAG,
		REPO_FLAG,
	],
	output:
		"{changed, number, project, columns:[name]}; a new board adds url. --dry-run adds dry_run and apply; a create plan has project and template, not unsaved columns.",
	examples: [
		"fgj write board create Onboarding",
		"fgj write board create Bugs --template bug-triage --dry-run",
	],
	prepare(args): CreateInput {
		const name = args.positionals[0];
		if (
			args.positionals.length !== 1 ||
			typeof name !== "string" ||
			!name.trim() ||
			[...name].length > 100 ||
			!name.isWellFormed() ||
			new TextEncoder().encode(name).byteLength > 255 ||
			name !== name.trim()
		)
			throw new FgjError(
				"usage",
				"board create needs one nonblank name in valid Unicode. Use at most 100 characters and 255 UTF-8 bytes, with no leading or trailing space.",
				"fgj help board create",
			);
		const template = args.flags.template ?? "basic-kanban";
		if (
			typeof template !== "string" ||
			!Object.hasOwn(PROJECT_TEMPLATES, template)
		)
			throw new FgjError(
				"usage",
				"--template needs none, basic-kanban, or bug-triage.",
				"fgj help board create",
			);
		return {
			name,
			template: template as CreateInput["template"],
			dryRun: args.flags["dry-run"] === true,
		};
	},
	async run(input, ctx) {
		const web = ctx.web();
		const open = await creationMatches(web, ctx, "open", input.name);
		const [only] = open;
		if (open.length > 1)
			throw new FgjError(
				"conflict",
				`Multiple open projects match this name: ${projectNames(open)}. No board changed.`,
				"fgj help board create",
			);
		let result: Record<string, unknown>;
		if (only) result = await creationResult(web, ctx, only, false);
		else {
			const closed = await creationMatches(web, ctx, "closed", input.name);
			if (closed.length)
				throw new FgjError(
					"conflict",
					`Only closed projects match this name: ${projectNames(closed)}. fgj does not reopen them.`,
					"fgj help board create",
				);
			const repo = await ctx.api.get<unknown>(
				`/repos/${ctx.target.owner}/${ctx.target.name}`,
			);
			if (
				typeof repo !== "object" ||
				repo === null ||
				!("archived" in repo) ||
				typeof repo.archived !== "boolean"
			)
				throw new FgjError(
					"api",
					"Forgejo returned no valid repository archive state. No board changed.",
					"fgj help board create",
				);
			if (repo.archived)
				throw new FgjError(
					"conflict",
					"The repository is archived. No board changed.",
					"fgj help board create",
				);
			if (input.dryRun)
				result = {
					changed: true,
					project: input.name,
					template: input.template,
				};
			else {
				await web.createProject(
					`/${ctx.target.owner}/${ctx.target.name}/projects/new`,
					{
						title: input.name,
						template_type: PROJECT_TEMPLATES[input.template],
						card_type: "1",
						content: "",
					},
				);
				const saved = await creationMatches(web, ctx, "open", input.name);
				const [created] = saved;
				if (saved.length !== 1 || !created)
					throw new FgjError(
						"api",
						`Creation is not confirmed: the saved name has ${saved.length} open matches. Check the project list before another create.`,
						"fgj help board create",
					);
				result = await creationResult(web, ctx, created, true);
			}
		}
		return input.dryRun
			? {
					dry_run: true,
					...result,
					apply: ctx.commandWith({ "dry-run": undefined }),
				}
			: result;
	},
};

interface ListInput {
	project?: string;
	column?: string;
}

/** `fgj read board list [--project N|TITLE] [--column NAME]`. */
export const boardList: ReadVerb<ListInput> = {
	risk: "read",
	noun: "board",
	action: "list",
	summary:
		"Read a project board: each column and the issue numbers of its cards, in board order.",
	notes: [
		"A board belongs to one repository. Without --project, fgj reads the repository's only open project; with more than one, the error lists them.",
		"board list reads repository projects only. board card can also name a user or organization project, which board list cannot open.",
		"Cards show issue and pull request numbers only. Use issue get for titles.",
		"An unknown project or column fails with the valid names.",
		LOGIN_NOTE,
	],
	args: [],
	flags: [
		PROJECT_FLAG,
		{
			name: "column",
			kind: "string",
			value: "NAME",
			description: "Read only this column. Case does not matter.",
		},
		REPO_FLAG,
	],
	output: "{project, columns:[{name, issues}]}",
	examples: [
		"fgj read board list",
		'fgj read board list --project "Plan" --column "To Do"',
	],
	prepare(args: ParsedArgs): ListInput {
		if (args.positionals.length > 0) {
			throw new FgjError(
				"usage",
				`board list takes no arguments, got "${args.positionals.join(" ")}". Name the project with --project.`,
				"fgj help board list",
			);
		}
		const { project, column } = args.flags;
		return {
			...(project === undefined ? {} : { project: String(project) }),
			...(column === undefined ? {} : { column: String(column) }),
		};
	},
	async run(input, ctx) {
		const hint = "fgj help board list";
		const { board } = await openBoard(ctx.web(), ctx, input.project, hint);
		const columns = input.column
			? [
					pickColumn(
						board,
						input.column,
						ctx.commandWith({ column: undefined }),
					),
				]
			: board.columns;
		const result = {
			project: board.title,
			columns: columns.map((c) => ({ name: c.name, issues: c.issues })),
		};
		const fits = (cols: readonly Column[]) =>
			JSON.stringify({
				project: board.title,
				columns: cols.map((c) => ({ name: c.name, issues: c.issues })),
			}).length <=
			OUTPUT_CAP - 200;
		if (!fits(columns)) {
			const first = board.columns[0];
			// Name a command that differs from this one and fits, or none.
			const hint =
				!input.column && first && fits([first])
					? ctx.commandWith({ column: first.name })
					: "fgj help board list";
			throw new FgjError(
				"usage",
				input.column
					? `The column ${columns[0]?.name} has too many cards for one result.`
					: `${board.title} has too many cards for one result. Read one column at a time.`,
				hint,
			);
		}
		return result;
	},
};

interface CardInput {
	refs: IssueRef[];
	remote?: IssueRef["remote"];
	single: boolean;
	bodyMax: number;
}

/** `fgj read board card <issue...>`: the project and column of each issue. */
export const boardCard: ReadVerb<CardInput> = {
	risk: "read",
	noun: "board",
	action: "card",
	summary: "Find the project and the board column of one or many issues.",
	notes: [
		"An issue is on one project at most. project is null when it is on none. A project of the owner (user or organization) also shows.",
		"When fgj cannot read the repository's boards (Projects unit off), an issue on no owner board fails with not_found instead of project null.",
		"fgj reads the boards, open projects first, until it finds each issue. An issue on no project makes it read every board.",
		"One issue returns {number, project, column}. Two or more return {items, missing}; missing lists the numbers that do not exist, and only when there are some.",
		LOGIN_NOTE,
	],
	args: [
		{
			name: "issue...",
			description: `Issue or pull request numbers, or their URLs, at most ${CARD_MAX}.`,
		},
	],
	flags: [REPO_FLAG],
	output:
		"One issue: {number, project, column}; project is null when the issue is on no project, unless fgj cannot read the repository's boards. Many: {items, missing}.",
	examples: ["fgj read board card 12", "fgj read board card 12 15 18"],
	prepare(args: ParsedArgs): CardInput {
		const { refs, remote } = issueRefs(args, CARD_MAX, "fgj help board card");
		return {
			refs,
			...(remote ? { remote } : {}),
			single: refs.length === 1,
			// Cards have no body, so no body hint applies.
			bodyMax: BODY_MAX_LIMIT,
		};
	},
	remoteOf(input) {
		return input.remote;
	},
	async run(input, ctx) {
		const web = ctx.web();
		const hint = "fgj help board card";
		const { owner, name } = ctx.target;
		const wanted = [...new Set(input.refs.map((r) => r.number))];
		let scan: ReturnType<typeof scanBoards> | undefined;
		const locate = () => {
			scan ??= scanBoards(web, ctx, hint, wanted);
			return scan;
		};
		const readOne = async (n: number) => {
			const { found, repoOff } = await locate();
			const hit = found.get(n);
			if (hit) {
				return { number: n, project: hit.board.title, column: hit.column.name };
			}
			try {
				await ctx.api.get(`/repos/${owner}/${name}/issues/${n}`);
			} catch (err) {
				if (err instanceof FgjError && err.code === "not_found") return null;
				throw err;
			}
			if (repoOff) throw hiddenBoards(ctx, n, hint);
			return { number: n, project: null };
		};
		const missingOne = async (ref: IssueRef) =>
			new FgjError(
				"not_found",
				`Issue ${ref.number} does not exist in ${owner}/${name}.`,
				"fgj help board card",
			);
		return readMany(input, ctx, readOne, missingOne, "fgj help board card");
	},
};

/** The input of `board add` and `board move`. */
interface PlaceInput {
	refs: IssueRef[];
	remote?: IssueRef["remote"];
	single: boolean;
	dryRun: boolean;
	project?: string;
	column?: string;
}

/** One issue's outcome in a board write. */
type PlaceItem =
	| { number: number; changed: boolean; column?: string | null }
	| { number: number; error: { code: string; message: string; hint: string } };

/** Reads the shared arguments of `board add` and `board move`. */
function placeInput(
	args: ParsedArgs,
	hint: string,
	needsColumn: boolean,
): PlaceInput {
	const { refs, remote } = issueRefs(args, CARD_MAX, hint);
	const { project, column } = args.flags;
	if (needsColumn && column === undefined) {
		throw new FgjError("usage", "Missing --column NAME.", hint);
	}
	return {
		refs,
		...(remote ? { remote } : {}),
		single: refs.length === 1,
		dryRun: args.flags["dry-run"] === true,
		...(project === undefined ? {} : { project: String(project) }),
		...(column === undefined ? {} : { column: String(column) }),
	};
}

/** The item for an error, or the error itself for a one-issue call. */
function failItem(input: PlaceInput, n: number, err: unknown): PlaceItem {
	if (!(err instanceof FgjError) || input.single) throw err;
	return { number: n, error: err.toJSON().error };
}

/** The result of a board write: one issue flat, many as items, as issue close does. */
function placeResult(
	input: PlaceInput,
	items: PlaceItem[],
	ctx: BoardCtx,
): Record<string | symbol, unknown> {
	const apply = ctx.commandWith(
		{ "dry-run": undefined },
		input.refs.map((r) => r.canonical),
	);
	if (input.single) {
		return {
			...(items[0] as PlaceItem),
			...(input.dryRun ? { dry_run: true, apply } : {}),
		};
	}
	const failed = items.find(
		(i): i is Extract<PlaceItem, { error: unknown }> => "error" in i,
	);
	return {
		...(input.dryRun ? { dry_run: true } : {}),
		changed: items.some((i) => "changed" in i && i.changed),
		items,
		...(input.dryRun ? { apply } : {}),
		...(failed ? { [FAILED]: failed.error.code } : {}),
	};
}

/**
 * Puts cards at the bottom of a column. Forgejo sets the position of each card
 * that the request names and packs every other card of the column after the
 * highest one, so fgj sends the whole column: the cards that stay, in their
 * order and from any repository, then the new ones. Each named card is set to
 * this column, so fgj reads the board just before the move: a stale list would
 * undo another agent's move. A change in the moment between the read and the
 * move can still be undone.
 *
 * @param fresh - A board read just now, so fgj does not read it twice in a row.
 * @returns The board after the move.
 */
async function placeAtBottom(
	web: WebWriter,
	ctx: BoardCtx,
	base: string,
	project: number,
	columnId: number,
	moving: readonly number[],
	fresh?: Board,
): Promise<Board> {
	const now = fresh ?? (await readBack(web, ctx, base, project));
	const column = now.columns.find((c) => c.id === columnId);
	if (!column) {
		throw new FgjError(
			"conflict",
			`A column of project ${project} was removed during the call.`,
			"fgj help board",
		);
	}
	const ids = moving
		.filter((n) => now.cards.has(n))
		.map((n) => now.cards.get(n) as number);
	// Every card left the project: nothing to move, and the caller reports each.
	if (ids.length === 0) return now;
	const order = [...column.cardIds.filter((id) => !ids.includes(id)), ...ids];
	const issues = order.map((issueID, sorting) => ({ issueID, sorting }));
	await web.post(`${base}/projects/${project}/${column.id}/move`, {
		json: { issues },
	});
	return readBack(web, ctx, base, project);
}

/** Reads a board again after a change: fgj reports only what the server saved. */
async function readBack(
	web: WebReader,
	ctx: BoardCtx,
	base: string,
	project: number,
): Promise<Board> {
	const page = await web.page(`${base}/projects/${project}`);
	if (!page) {
		throw new FgjError(
			"api",
			`The board of project ${project} is gone after the change.`,
			"fgj help board",
		);
	}
	return parseBoard(page.html, linkBase(ctx));
}

/** The column that holds an issue on a board, or `undefined`. */
function columnOf(board: Board, n: number): Column | undefined {
	return board.columns.find((c) => c.issues.includes(n));
}

/** The error for a change that the server answered with ok but did not save. */
function notSaved(n: number, what: string): FgjError {
	return new FgjError(
		"api",
		`Forgejo answered ok, but the board does not show issue ${n} ${what}. The account may lack permission for this project.`,
		"fgj auth status",
	);
}

const COLUMN_FLAG: FlagSpec = {
	name: "column",
	kind: "string",
	value: "NAME",
	description: "The column. Case does not matter.",
};

/** `fgj write board add <issue...> [--project N|TITLE] [--column NAME]`. */
export const boardAdd: WriteVerb<PlaceInput> = {
	risk: "write",
	noun: "board",
	action: "add",
	summary:
		"Add one or many issues to a repository project, optionally into a column.",
	notes: [
		"Without --column, a new card goes to the project's default column. With --column, it goes to the bottom of that column; the other cards keep their order.",
		"An issue already on the project returns changed:false. With --column of another column, fgj moves the card there: the command states the end state.",
		"Forgejo keeps an issue on one project at most. An issue on another project fails with conflict and names it; fgj does not move it off.",
		"Several new cards without --column land in the default column; fgj then moves them to its bottom in argument order, which is a move like any other.",
		"fgj reads the board back and reports only what the server saved.",
		"fgj reads the board just before each move and names every card of the column, so the other cards keep their order. A change that another agent makes to that column in the same moment can be undone. Cards of repositories that the account cannot see go below the moved cards.",
		"One issue returns {changed, number, column}. Many return {changed, items}; a failed item has error, and the exit code is the first failure's. A --dry-run without --column leaves column out: the server picks it.",
		LOGIN_NOTE,
	],
	args: [
		{
			name: "issue...",
			description: `Issue or pull request numbers, or their URLs, at most ${CARD_MAX}.`,
		},
	],
	flags: [PROJECT_FLAG, COLUMN_FLAG, DRY_RUN_FLAG, REPO_FLAG],
	output:
		"One issue: {changed, number, column}. Many: {changed, items:[{number, changed, column} or {number, error}]}. --dry-run adds dry_run and apply.",
	examples: [
		"fgj write board add 12",
		'fgj write board add 12 13 --project "Plan" --column "To Do"',
	],
	prepare(args: ParsedArgs): PlaceInput {
		return placeInput(args, "fgj help board add", false);
	},
	remoteOf(input) {
		return input.remote;
	},
	async run(input, ctx) {
		const hint = "fgj help board add";
		const web = ctx.web();
		const { owner, name } = ctx.target;
		const repo = `/${owner}/${name}`;
		const wanted = [...new Set(input.refs.map((r) => r.number))];
		const { number, board } = await openBoard(web, ctx, input.project, hint);
		const listHint = ctx.commandFor("read board list", [], {
			project: String(number),
		});
		const column = input.column
			? pickColumn(board, input.column, listHint)
			: undefined;
		const items = new Map<number, PlaceItem>();
		const onBoard = wanted.filter((n) => columnOf(board, n));
		const elsewhere = await scanBoards(
			web,
			ctx,
			hint,
			wanted.filter((n) => !columnOf(board, n)),
			{ base: repo, number },
		);
		const toAdd: { n: number; id: number }[] = [];
		for (const n of wanted.filter((m) => !columnOf(board, m))) {
			try {
				const other = elsewhere.found.get(n);
				if (other) {
					throw new FgjError(
						"conflict",
						`Issue ${n} is on project "${other.board.title}", column ${other.column.name}. Forgejo keeps an issue on one project, and fgj does not move it off.`,
						ctx.commandFor("read board card", [String(n)]),
					);
				}
				const issue = await ctx.api
					.get<{ id: number }>(`/repos/${owner}/${name}/issues/${n}`)
					.catch((err: unknown) => {
						if (err instanceof FgjError && err.code === "not_found") {
							throw new FgjError(
								"not_found",
								`Issue ${n} does not exist in ${owner}/${name}.`,
								hint,
							);
						}
						throw err;
					});
				toAdd.push({ n, id: issue.id });
			} catch (err) {
				items.set(n, failItem(input, n, err));
			}
		}
		// Cards already on the project that --column sends to another column.
		const moving = column
			? onBoard.filter((n) => columnOf(board, n)?.id !== column.id)
			: [];
		for (const n of onBoard) {
			if (!moving.includes(n)) {
				items.set(n, {
					number: n,
					changed: false,
					column: columnOf(board, n)?.name ?? null,
				});
			}
		}
		// Argument order, for the results and for the order of the new cards.
		const added = new Set(toAdd.map((a) => a.n));
		const placed = wanted.filter((n) => added.has(n) || moving.includes(n));
		if (input.dryRun) {
			// Without --column, the server picks the column, so fgj does not name it.
			for (const n of placed) {
				items.set(n, {
					number: n,
					changed: true,
					...(column ? { column: column.name } : {}),
				});
			}
		} else if (placed.length > 0) {
			let after: Board | undefined;
			try {
				if (toAdd.length > 0) {
					await web.post(`${repo}/issues/projects`, {
						form: {
							issue_ids: toAdd.map((a) => a.id).join(","),
							id: String(number),
						},
					});
				}
				const saved = await readBack(web, ctx, repo, number);
				after = saved;
				const landed = placed.filter((n) => added.has(n) && saved.cards.has(n));
				// New cards land in the default column in the server's order; with more
				// than one, fgj puts them at its bottom in argument order.
				const targetId =
					column?.id ??
					(landed.length > 1
						? columnOf(saved, landed[0] as number)?.id
						: undefined);
				const toPlace = column
					? placed.filter((n) => saved.cards.has(n))
					: landed.length > 1
						? landed
						: [];
				if (targetId !== undefined && toPlace.length > 0) {
					try {
						after = await placeAtBottom(
							web,
							ctx,
							repo,
							number,
							targetId,
							toPlace,
							saved,
						);
					} catch (err) {
						if (!(err instanceof FgjError)) throw err;
						// The add saved: say so, so the agent and the audit see it. A card
						// that the add did not save gets its own result below.
						for (const n of toPlace) {
							const note = landed.includes(n)
								? new FgjError(
										err.code,
										`Issue ${n} is now on project ${number}, column ${columnOf(saved, n)?.name}, but the move to ${column?.name ?? "the bottom of that column"} is not confirmed: ${err.message}`,
										err.hint,
									)
								: err;
							items.set(n, failItem(input, n, note));
						}
					}
				}
			} catch (err) {
				for (const n of placed) {
					if (!items.has(n)) items.set(n, failItem(input, n, err));
				}
			}
			// Each card gets its own result from the board that the server saved.
			for (const n of placed) {
				if (items.has(n) || !after) continue;
				const now = columnOf(after, n);
				try {
					if (!now) throw notSaved(n, `on project ${number}`);
					if (column && now.id !== column.id) {
						throw notSaved(n, `in column ${column.name}`);
					}
					items.set(n, { number: n, changed: true, column: now.name });
				} catch (err) {
					items.set(n, failItem(input, n, err));
				}
			}
		}
		return placeResult(
			input,
			wanted.map((n) => items.get(n) as PlaceItem),
			ctx,
		);
	},
};

/** `fgj write board move <issue...> --column NAME`. */
export const boardMove: WriteVerb<PlaceInput> = {
	risk: "write",
	noun: "board",
	action: "move",
	summary: "Move the cards of one or many issues to a column of their project.",
	notes: [
		"Each card moves inside the project it is on, to the bottom of the column; the other cards keep their order. A user or organization board works too.",
		"A card already in the column returns changed:false. An issue on no project fails with conflict; add it with board add.",
		"fgj reads the board back and reports only what the server saved.",
		"fgj reads the board just before each move and names every card of the column, so the other cards keep their order. A change that another agent makes to that column in the same moment can be undone. Cards of repositories that the account cannot see go below the moved cards.",
		"One issue returns {changed, number, column}. Many return {changed, items}; a failed item has error, and the exit code is the first failure's.",
		LOGIN_NOTE,
	],
	args: [
		{
			name: "issue...",
			description: `Issue or pull request numbers, or their URLs, at most ${CARD_MAX}.`,
		},
	],
	flags: [{ ...COLUMN_FLAG, required: true }, DRY_RUN_FLAG, REPO_FLAG],
	output:
		"One issue: {changed, number, column}. Many: {changed, items:[{number, changed, column} or {number, error}]}. --dry-run adds dry_run and apply.",
	examples: [
		'fgj write board move 12 --column "In Progress"',
		"fgj write board move 12 13 --column Done --dry-run",
	],
	prepare(args: ParsedArgs): PlaceInput {
		return placeInput(args, "fgj help board move", true);
	},
	remoteOf(input) {
		return input.remote;
	},
	async run(input, ctx) {
		const hint = "fgj help board move";
		const web = ctx.web();
		const { owner, name } = ctx.target;
		const wanted = [...new Set(input.refs.map((r) => r.number))];
		const target = input.column as string;
		const { found, repoOff } = await scanBoards(web, ctx, hint, wanted);
		const items = new Map<number, PlaceItem>();
		for (const n of wanted.filter((m) => !found.has(m))) {
			try {
				await ctx.api
					.get(`/repos/${owner}/${name}/issues/${n}`)
					.catch((err: unknown) => {
						if (err instanceof FgjError && err.code === "not_found") {
							throw new FgjError(
								"not_found",
								`Issue ${n} does not exist in ${owner}/${name}.`,
								hint,
							);
						}
						throw err;
					});
				if (repoOff) throw hiddenBoards(ctx, n, hint);
				throw new FgjError(
					"conflict",
					`Issue ${n} is on no project. Add it first.`,
					ctx.commandFor("write board add", [String(n)], { column: target }),
				);
			} catch (err) {
				items.set(n, failItem(input, n, err));
			}
		}
		// One request per board: the cards of all issues on it move together.
		const groups = new Map<string, number[]>();
		for (const n of wanted.filter((m) => found.has(m))) {
			const at = found.get(n) as Location;
			const key = `${at.base}/projects/${at.number}`;
			groups.set(key, [...(groups.get(key) ?? []), n]);
		}
		for (const group of groups.values()) {
			const at = found.get(group[0] as number) as Location;
			try {
				const listHint = at.base.endsWith("/-")
					? hint
					: ctx.commandFor("read board list", [], {
							project: String(at.number),
						});
				const column = pickColumn(at.board, target, listHint);
				const moving = group.filter(
					(n) => (found.get(n) as Location).column.id !== column.id,
				);
				for (const n of group) {
					if (!moving.includes(n)) {
						items.set(n, { number: n, changed: false, column: column.name });
					}
				}
				if (moving.length === 0) continue;
				if (input.dryRun) {
					for (const n of moving) {
						items.set(n, { number: n, changed: true, column: column.name });
					}
					continue;
				}
				const after = await placeAtBottom(
					web,
					ctx,
					at.base,
					at.number,
					column.id,
					moving,
				);
				// Each card gets its own result from the board that the server saved.
				for (const n of moving) {
					try {
						if (!after.cards.has(n)) {
							throw new FgjError(
								"conflict",
								`Issue ${n} is no longer on project ${at.number}: it left during the call.`,
								ctx.commandFor("read board card", [String(n)]),
							);
						}
						if (columnOf(after, n)?.id !== column.id) {
							throw notSaved(n, `in column ${column.name}`);
						}
						items.set(n, { number: n, changed: true, column: column.name });
					} catch (err) {
						items.set(n, failItem(input, n, err));
					}
				}
			} catch (err) {
				for (const n of group) {
					if (!items.has(n)) items.set(n, failItem(input, n, err));
				}
			}
		}
		return placeResult(
			input,
			wanted.map((n) => items.get(n) as PlaceItem),
			ctx,
		);
	},
};

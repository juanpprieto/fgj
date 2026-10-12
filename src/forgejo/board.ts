import { FgjError } from "../core/errors.ts";

/**
 * Readers for Forgejo's project web pages. Forgejo has no board API, so fgj
 * reads the same HTML that the browser gets. Each reader fails loudly when the
 * page lacks the markers it needs, so a Forgejo upgrade that changes the
 * layout gives an error, never a wrong answer.
 */

/** One column of a board, with the issue numbers of its cards in board order. */
export interface Column {
	/** The column id that Forgejo's move route takes. */
	id: number;
	name: string;
	issues: number[];
	/**
	 * The card ids of every card in the column, in order, from any repository.
	 * A move names them all, so no other card changes position.
	 */
	cardIds: number[];
}

/** A project board page. */
export interface Board {
	title: string;
	columns: Column[];
	/** The card id (`data-issue`) of each issue number. Only moves need it. */
	cards: Map<number, number>;
}

/** A project in the project list. */
export interface ProjectRef {
	number: number;
	title: string;
}

/** One page of the project list. */
export interface ProjectList {
	projects: ProjectRef[];
	/** True when the page links to the next page. */
	more: boolean;
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/**
 * Decodes the HTML character references in text that the HTML rewriter gives
 * as written in the page.
 *
 * @param text - Raw HTML text, for example `Q&amp;A`.
 * @returns The text, for example `Q&A`.
 * @example
 * decodeHtml("R&amp;D &#39;26"); // "R&D '26"
 */
export function decodeHtml(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, ref: string) => {
		if (ref[0] === "#") {
			const code =
				ref[1] === "x" || ref[1] === "X"
					? Number.parseInt(ref.slice(2), 16)
					: Number(ref.slice(1));
			return Number.isFinite(code) ? String.fromCodePoint(code) : all;
		}
		return ENTITIES[ref.toLowerCase()] ?? all;
	});
}

function layoutChanged(page: string): FgjError {
	return new FgjError(
		"api",
		`fgj cannot read the ${page}: the page lacks the parts fgj reads. A Forgejo upgrade may have changed it.`,
		"fgj help board",
	);
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reads a project board page. A user or organization board holds cards from
 * several repositories, so it keeps only the cards of one repository.
 *
 * @param html - The page from `GET /{owner}/{repo}/projects/{number}` or `GET /{owner}/-/projects/{number}`.
 * @param repoPath - `/{owner}/{repo}` of the cards to keep, with the base URL's path prefix. Case does not matter.
 * @returns The title, the columns in board order, and the card ids.
 * @throws {FgjError} An api error when the page has no title or no board container.
 * @example
 * const board = await parseBoard(html, "/acme/web");
 * board.columns.map((c) => c.name); // ["Backlog", "To Do", "Done"]
 */
export async function parseBoard(
	html: string,
	repoPath: string,
): Promise<Board> {
	const link = new RegExp(
		`^${escapeRegex(repoPath)}/(?:issues|pulls)/(\\d+)$`,
		"i",
	);
	const columns: Column[] = [];
	const cards = new Map<number, number>();
	let title: string | undefined;
	let board = false;
	let column: Column | undefined;
	let inName = false;
	let name = "";
	let card = 0;
	await new HTMLRewriter()
		.on("div.view-project[aria-label]", {
			element(e) {
				title = decodeHtml(e.getAttribute("aria-label") ?? "");
			},
		})
		.on("div#project-board", {
			element() {
				board = true;
			},
		})
		.on("div.project-column", {
			element(e) {
				column = {
					id: Number(e.getAttribute("data-id")),
					name: "",
					issues: [],
					cardIds: [],
				};
				columns.push(column);
			},
		})
		.on(".project-column-title-label", {
			element(e) {
				inName = true;
				name = "";
				e.onEndTag(() => {
					inName = false;
					if (column) column.name = decodeHtml(name).trim();
				});
			},
			text(t) {
				if (inName) name += t.text;
			},
		})
		.on("div.issue-card[data-issue]", {
			element(e) {
				card = Number(e.getAttribute("data-issue"));
				if (column && card > 0) column.cardIds.push(card);
			},
		})
		.on("a.issue-card-title[href]", {
			element(e) {
				const n = Number(link.exec(e.getAttribute("href") ?? "")?.[1]);
				if (column && n > 0) {
					column.issues.push(n);
					cards.set(n, card);
				}
			},
		})
		.transform(new Response(html))
		.text();
	// A project can have no columns, so the board container is the marker.
	if (
		title === undefined ||
		!title.trim() ||
		!board ||
		columns.some((c) => !Number.isSafeInteger(c.id) || c.id <= 0 || !c.name) ||
		new Set(columns.map((c) => c.id)).size !== columns.length
	)
		throw layoutChanged("board page");
	return { title, columns, cards };
}

/**
 * Reads one page of a repository's project list. Only accounts that can
 * write projects see the open and closed counts, so fgj pages instead.
 *
 * @param html - The page from `GET /{owner}/{repo}/projects?page={page}`.
 * @param repoPath - `/{owner}/{repo}`, with the base URL's path prefix, as in the page links. Case does not matter.
 * @param page - The page number that `html` shows.
 * @returns The projects on the page, and whether a next page exists.
 * @throws {FgjError} An api error when the page has no project list.
 * @example
 * const { projects, more } = await parseProjectList(html, "/acme/web", 1);
 */
export async function parseProjectList(
	html: string,
	repoPath: string,
	page: number,
): Promise<ProjectList> {
	const link = new RegExp(`^${escapeRegex(repoPath)}/projects/(\\d+)$`, "i");
	const next = new RegExp(`[?&]page=${page + 1}(?:&|$)`);
	const projects: ProjectRef[] = [];
	let list = false;
	let more = false;
	let current: ProjectRef | undefined;
	await new HTMLRewriter()
		.on("div.milestone-list", {
			element() {
				list = true;
			},
		})
		.on("div.milestone-list h3 a[href]", {
			element(e) {
				const n = link.exec(e.getAttribute("href") ?? "")?.[1];
				if (!n) return;
				current = { number: Number(n), title: "" };
				projects.push(current);
				e.onEndTag(() => {
					if (current) current.title = decodeHtml(current.title).trim();
					current = undefined;
				});
			},
			text(t) {
				if (current) current.title += t.text;
			},
		})
		.on(".pagination a[href]", {
			element(e) {
				if (next.test(decodeHtml(e.getAttribute("href") ?? ""))) more = true;
			},
		})
		.transform(new Response(html))
		.text();
	if (!list) throw layoutChanged("project list");
	return { projects, more };
}

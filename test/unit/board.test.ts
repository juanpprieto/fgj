import { describe, expect, test } from "bun:test";
import {
	decodeHtml,
	parseBoard,
	parseProjectList,
} from "../../src/forgejo/board.ts";
import { parseSetCookie } from "../../src/forgejo/web.ts";

/** Synthetic board HTML with card IDs 101–103, separate from issue numbers. */
const BOARD = `<div role="main" aria-label="Q&amp;A board" class="page-content repository projects view-project">
<h2>Q&amp;A board</h2><div id="project-board">
<div class="project-column" data-id="9"><div class="project-column-title-label">Backlog</div>
  <div class="issue-card" data-issue="101"><a class="issue-card-title" href="/o/r/issues/1">One</a></div>
  <div class="issue-card" data-issue="102"><a class="issue-card-title" href="/o/r/pulls/5">A PR</a></div>
</div>
<div class="project-column" data-id="10"><div class="project-column-title-label"> To &amp; Do </div>
  <div class="issue-card" data-issue="103"><a class="issue-card-title" href="/o/other/issues/1">Another repository</a></div>
</div>
</div></div>`;

const LIST = `<div class="milestone-list">
<li class="milestone-card"><h3><svg></svg> <a class="muted tw-break-anywhere" href="/git/o/r/projects/3">Alpha &amp; B</a></h3></li>
<li class="milestone-card"><h3><a class="muted" href="/git/o/other/projects/9">Elsewhere</a></h3></li>
<li class="milestone-card"><h3><a class="muted" href="/git/o/r/projects/4">Beta</a></h3></li>
<div class="ui borderless pagination menu">
<a class="item" href="/git/o/r/projects?page=1&amp;state=open">1</a>
<a class="item navigation" href="/git/o/r/projects?page=2&amp;state=open">Next</a>
</div></div>`;

describe("board page readers", () => {
	test("parseBoard reads the title, the columns in order, and the numbers of this repository's issue and PR cards, in any case", async () => {
		const board = await parseBoard(BOARD, "/O/R");
		expect(board.title).toBe("Q&A board");
		expect(board.columns).toEqual([
			{ id: 9, name: "Backlog", issues: [1, 5], cardIds: [101, 102] },
			// Another repository's card counts for moves, not as an issue here.
			{ id: 10, name: "To & Do", issues: [], cardIds: [103] },
		]);
		expect([...board.cards]).toEqual([
			[1, 101],
			[5, 102],
		]);
	});

	test("a page with the project title but no board container fails as a layout change", async () => {
		const noBoard = `<div role="main" aria-label="uat" class="page-content repository projects view-project"><h2>uat</h2></div>`;
		await expect(parseBoard(noBoard, "/o/r")).rejects.toThrow(
			/Forgejo upgrade/,
		);
	});

	test("a board with no columns reads as no columns, not as a layout change", async () => {
		const empty = `<div role="main" aria-label="uat" class="page-content repository projects view-project">
<h2>uat</h2><div id="project-board"><div class="board sortable"></div></div></div>`;
		expect(await parseBoard(empty, "/o/r")).toEqual({
			title: "uat",
			columns: [],
			cards: new Map(),
		});
	});

	test("malformed columns never read as verified saved columns", async () => {
		for (const column of [
			'<div class="project-column"><div class="project-column-title-label">One</div></div>',
			'<div class="project-column" data-id="wrong"><div class="project-column-title-label">One</div></div>',
			'<div class="project-column" data-id="1"></div>',
			'<div class="project-column" data-id="1"><div class="project-column-title-label"> </div></div>',
		]) {
			await expect(
				parseBoard(
					`<div class="view-project" aria-label="Plan"><div id="project-board">${column}</div></div>`,
					"/o/r",
				),
			).rejects.toMatchObject({ code: "api" });
		}
	});

	test("saved column names round-trip HTML escaping for empty, one, and large boards", async () => {
		const escaped = (text: string) =>
			text
				.replaceAll("&", "&amp;")
				.replaceAll("<", "&lt;")
				.replaceAll('"', "&quot;");
		for (const count of [0, 1, 100]) {
			const names = Array.from(
				{ length: count },
				(_, i) => `Column ${i} & <tag> "quoted" Ω`,
			);
			const html = `<div class="view-project" aria-label="Plan"><div id="project-board">${names.map((name, i) => `<div class="project-column" data-id="${i + 1}"><div class="project-column-title-label">${escaped(name)}</div></div>`).join("")}</div></div>`;
			expect(
				(await parseBoard(html, "/o/r")).columns.map((c) => c.name),
			).toEqual(names);
		}
	});

	test("a page without the board parts fails, so a layout change never reads as an empty board", async () => {
		await expect(
			parseBoard("<html><body>Sign in</body></html>", "/o/r"),
		).rejects.toThrow(/Forgejo upgrade/);
		await expect(parseProjectList("<p>nothing</p>", "/o/r", 1)).rejects.toThrow(
			/Forgejo upgrade/,
		);
	});

	test("parseProjectList keeps this repository's projects, under a path prefix, and sees a next page", async () => {
		expect(await parseProjectList(LIST, "/git/o/r", 1)).toEqual({
			projects: [
				{ number: 3, title: "Alpha & B" },
				{ number: 4, title: "Beta" },
			],
			more: true,
		});
		// On page 2 the same links name no page 3; an empty list is still a list.
		expect((await parseProjectList(LIST, "/git/o/r", 2)).more).toBe(false);
		expect(
			await parseProjectList('<div class="milestone-list"></div>', "/o/r", 1),
		).toEqual({ projects: [], more: false });
	});

	test("decodeHtml turns character references into text", () => {
		expect(decodeHtml("R&amp;D &#39;26 &#x41; &lt;b&gt; &bogus;")).toBe(
			"R&D '26 A <b> &bogus;",
		);
	});
});

describe("parseSetCookie", () => {
	test("reads Max-Age, Expires, and a cleared cookie", () => {
		expect(parseSetCookie("persistent=abc; Path=/; Max-Age=60", 0)).toEqual({
			name: "persistent",
			value: "abc",
			lifetime: 60_000,
		});
		expect(
			parseSetCookie("x=1; Expires=Thu, 01 Jan 1970 00:01:00 GMT", 0),
		).toEqual({ name: "x", value: "1", lifetime: 60_000 });
		expect(parseSetCookie("session=abc; Path=/; HttpOnly", 0)).toEqual({
			name: "session",
			value: "abc",
		});
		expect(parseSetCookie("redirect_to=; Path=/; Max-Age=0", 0).lifetime).toBe(
			0,
		);
	});
});

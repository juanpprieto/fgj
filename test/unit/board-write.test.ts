import { describe, expect, test } from "bun:test";
import { FgjError } from "../../src/core/errors.ts";
import type { VerbContext } from "../../src/core/verb.ts";
import type { WriteApi } from "../../src/forgejo/client.ts";
import type { WebBody, WebWriter } from "../../src/forgejo/web.ts";
import { boardAdd, boardCreate, boardMove } from "../../src/verbs/board.ts";

/** One card: the issue number and its card id. */
interface Card {
	n: number;
	id: number;
}

/**
 * A fake repository board for the verbs: one project (4) in /o/r with
 * columns Backlog (1) and To Do (2), served as Forgejo 16 HTML. `onMove`
 * decides what a move request saves, so a test can make the server fail.
 */
function fakeBoard(columns: { id: number; name: string; cards: Card[] }[]) {
	const state = {
		columns,
		posts: [] as string[],
		bodies: [] as unknown[],
		boardReads: 0,
		/** Runs before each board read, to change the board as another agent would. */
		onRead: (_count: number) => {},
	};
	let onMove = (ids: number[], column: number) => {
		for (const c of state.columns) {
			c.cards = c.cards.filter((k) => !ids.includes(k.id));
		}
		const target = state.columns.find((c) => c.id === column);
		if (!target) return;
		const moved = ids.map((id) => ({ n: id - 1000, id }));
		target.cards = [...moved];
	};
	const html = () =>
		`<div role="main" aria-label="Plan" class="page-content view-project"><div id="project-board">${state.columns
			.map(
				(c) =>
					`<div class="project-column" data-id="${c.id}"><div class="project-column-title-label">${c.name}</div>${c.cards
						.map(
							(k) =>
								`<div class="issue-card" data-issue="${k.id}"><a class="issue-card-title" href="/o/r/issues/${k.n}">x</a></div>`,
						)
						.join("")}</div>`,
			)
			.join("")}</div></div>`;
	const web = {
		async page(path: string) {
			if (path.startsWith("/o/r/projects?")) {
				return {
					path,
					html: '<div class="milestone-list"><h3><a href="/o/r/projects/4">Plan</a></h3></div>',
				};
			}
			if (path === "/o/r/projects/4") {
				state.onRead(++state.boardReads);
				return { path, html: html() };
			}
			return null;
		},
		async post(path: string, body: WebBody) {
			state.posts.push(path);
			state.bodies.push("json" in body ? body.json : body.form);
			if (path === "/o/r/issues/projects" && "form" in body) {
				const ids = (body.form.issue_ids ?? "").split(",").map(Number);
				const first = state.columns[0] as { cards: Card[] };
				for (const id of ids) first.cards.push({ n: id - 1000, id });
				return;
			}
			const m = /\/projects\/4\/(\d+)\/move$/.exec(path);
			if (m && "json" in body) {
				const issues = (body.json as { issues: { issueID: number }[] }).issues;
				onMove(
					issues.map((i) => i.issueID),
					Number(m[1]),
				);
			}
		},
	};
	const ctx = {
		target: {
			baseUrl: "https://git.example.com",
			owner: "o",
			name: "r",
			repoFromFlag: false,
			hostSource: "origin",
		},
		api: {
			get: async (path: string) => ({
				id: Number(/issues\/(\d+)$/.exec(path)?.[1]) + 1000,
			}),
		},
		web: () => web,
		commandWith: () => "fgj write board",
		commandFor: (words: string, args: readonly string[]) =>
			`fgj ${words} ${args.join(" ")}`,
	} as unknown as VerbContext<WriteApi, WebWriter>;
	return {
		state,
		ctx,
		setMove(fn: typeof onMove) {
			onMove = fn;
		},
	};
}

/** Repository inventory with observable writes and controlled read-back. */
function createFixture(
	open: { number: number; title: string }[] = [],
	closed: { number: number; title: string }[] = [],
) {
	const state = {
		open,
		closed,
		writes: [] as unknown[],
		columns: ["Saved one", "Saved two"],
		failRead: false,
		malformed: false,
		failWrite: false,
		save: true,
		pages: false,
		repo: { archived: false } as unknown,
	};
	const web = {
		async page(path: string) {
			if (path.includes("projects?")) {
				const query = new URLSearchParams(path.split("?")[1]);
				const all = query.get("state") === "closed" ? state.closed : state.open;
				const page = Number(query.get("page") ?? 1);
				const items = state.pages ? all.slice(page - 1, page) : all;
				return {
					path,
					html: `<div class="milestone-list">${items.map((p) => `<h3><a href="/o/r/projects/${p.number}">${p.title}</a></h3>`).join("")}</div>${state.pages && page < all.length ? `<div class="pagination"><a href="?page=${page + 1}">Next</a></div>` : ""}`,
				};
			}
			if (state.failRead) return null;
			if (state.malformed)
				return {
					path,
					html: '<div class="view-project" aria-label="Plan"><div id="project-board"><div class="project-column" data-id="broken"></div></div></div>',
				};
			const p = state.open.find((p) => path.endsWith(`/${p.number}`));
			return {
				path,
				html: `<div class="view-project" aria-label="${p?.title}"><div id="project-board">${state.columns.map((c, i) => `<div class="project-column" data-id="${i + 1}"><div class="project-column-title-label">${c}</div></div>`).join("")}</div></div>`,
			};
		},
		async createProject(path: string, form: Record<string, string>) {
			state.writes.push({ path, form });
			if (state.save)
				state.open.push({ number: 7, title: form.title as string });
			if (state.failWrite)
				throw new FgjError("api", "Lost response", "fgj help");
		},
	};
	const ctx = {
		target: { baseUrl: "https://git.example.com", owner: "o", name: "r" },
		web: () => web,
		api: { get: async () => state.repo },
		commandWith: () => "fgj write board create Plan",
		commandFor: () => "fgj read board list --project 7",
	} as unknown as VerbContext<WriteApi, WebWriter>;
	return { state, ctx };
}
const createInput = (name = "Plan", template?: string, dryRun = false) =>
	boardCreate.prepare(
		{
			positionals: [name],
			flags: {
				...(template === undefined ? {} : { template }),
				...(dryRun ? { "dry-run": true } : {}),
			},
		},
		{ cwd: "/", home: undefined },
	);

describe("board create criterion contract", () => {
	test("default creation confirms saved columns", async () => {
		const f = createFixture();
		expect(await boardCreate.run(createInput(), f.ctx)).toEqual({
			changed: true,
			number: 7,
			url: "https://git.example.com/o/r/projects/7",
			project: "Plan",
			columns: ["Saved one", "Saved two"],
		});
		expect(f.state.writes).toEqual([
			{
				path: "/o/r/projects/new",
				form: {
					title: "Plan",
					template_type: "1",
					card_type: "1",
					content: "",
				},
			},
		]);
	});
	test("each template uses its server value and saved columns, including empty", async () => {
		for (const [template, value] of [
			["none", "0"],
			["basic-kanban", "1"],
			["bug-triage", "2"],
		]) {
			const f = createFixture();
			f.state.columns = template === "none" ? [] : ["Configured"];
			expect(
				await boardCreate.run(createInput("Plan", template), f.ctx),
			).toMatchObject({ columns: f.state.columns });
			expect(f.state.writes[0]).toMatchObject({
				form: { template_type: value },
			});
		}
	});
	test("unique open match wins over closed and different template, with no writes", async () => {
		const f = createFixture(
			[{ number: 4, title: "PLAN" }],
			[{ number: 5, title: "Plan" }],
		);
		expect(
			await boardCreate.run(createInput("plan", "none"), f.ctx),
		).toMatchObject({
			changed: false,
			number: 4,
			project: "PLAN",
			columns: f.state.columns,
		});
		expect(f.state.writes).toEqual([]);
	});
	test("ambiguity across complete pages and closed-only names never write", async () => {
		for (const f of [
			createFixture([
				{ number: 4, title: "Plan" },
				{ number: 5, title: "plan" },
			]),
			createFixture([], [{ number: 6, title: "PLAN" }]),
		]) {
			f.state.pages = true;
			await expect(boardCreate.run(createInput(), f.ctx)).rejects.toMatchObject(
				{
					code: "conflict",
					message: expect.stringContaining(
						String(f.state.open.at(-1)?.number ?? 6),
					),
				},
			);
			expect(f.state.writes).toEqual([]);
		}
	});
	test("lost accepted response, missing match, failed and malformed read-back never return success or retry", async () => {
		for (const fault of [
			"failWrite",
			"failRead",
			"malformed",
			"save",
		] as const) {
			const f = createFixture();
			f.state[fault] = fault !== "save";
			await expect(boardCreate.run(createInput(), f.ctx)).rejects.toMatchObject(
				{ code: "api" },
			);
			expect(f.state.writes).toHaveLength(1);
		}
	});
	test("invalid name or template fails before any network", () => {
		for (const positionals of [
			[],
			[""],
			["   "],
			["x".repeat(101)],
			[" Plan"],
			["Plan "],
			["\ud800"],
			["\udc00"],
			["a", "b"],
			[42] as unknown as string[],
		]) {
			expect(() =>
				boardCreate.prepare(
					{ positionals, flags: {} },
					{ cwd: "/", home: undefined },
				),
			).toThrow(FgjError);
		}
		for (const template of ["", "unknown", true, 1] as const) {
			expect(() =>
				boardCreate.prepare(
					{ positionals: ["Plan"], flags: { template } },
					{ cwd: "/", home: undefined },
				),
			).toThrow(FgjError);
		}
	});
	test.each([
		["emoji 256 bytes", "😀".repeat(64)],
		["CJK 256 bytes", `${"界".repeat(85)}a`],
		["emoji100", "😀".repeat(100)],
		["CJK100", "界".repeat(100)],
		["unpaired high surrogate", "\ud800"],
		["unpaired low surrogate", "\udc00"],
	])("UTF-8 refusal is repeat safe: %s", async (_label, name) => {
		const f = createFixture();
		for (const dryRun of [false, false, true]) {
			const attempt = async () =>
				boardCreate.run(createInput(name, undefined, dryRun), f.ctx);
			await expect(attempt()).rejects.toMatchObject({
				code: "usage",
				message: expect.stringContaining("255 UTF-8 bytes"),
			});
			expect(f.state.writes).toEqual([]);
			expect(f.state.open).toEqual([]);
		}
	});
	test.each([
		["emoji 255 bytes", `${"😀".repeat(63)}abc`],
		["CJK 255 bytes", "界".repeat(85)],
		["ASCII100", "a".repeat(100)],
		["accented100", "é".repeat(100)],
		["decomposed100", "e\u0301".repeat(50)],
		["short emoji", "😀"],
	])(
		"UTF-8 passing control creates once and reuses: %s",
		async (_label, name) => {
			const f = createFixture();
			expect(await boardCreate.run(createInput(name), f.ctx)).toMatchObject({
				changed: true,
				project: name,
			});
			for (const dryRun of [false, true]) {
				expect(
					await boardCreate.run(createInput(name, "none", dryRun), f.ctx),
				).toMatchObject({ changed: false, number: 7, project: name });
				expect(f.state.writes).toHaveLength(1);
				expect(f.state.open).toEqual([{ number: 7, title: name }]);
			}
		},
	);
	test("name acceptance holds for generated Unicode lengths", () => {
		for (const symbol of ["a", "é", "界", "😀"]) {
			for (let count = 1; count <= 101; count++) {
				const name = symbol.repeat(count);
				const accepted = count <= 100 && new Blob([name]).size <= 255;
				if (accepted) expect(createInput(name).name).toBe(name);
				else expect(() => createInput(name)).toThrow(FgjError);
			}
		}
	});
	test("missing or corrupt repository state fails closed before a write", async () => {
		for (const repo of [
			undefined,
			null,
			{},
			[],
			"",
			{ archived: "false" },
			{ archived: 0 },
		]) {
			const f = createFixture();
			f.state.repo = repo;
			await expect(boardCreate.run(createInput(), f.ctx)).rejects.toMatchObject(
				{ code: "api" },
			);
			expect(f.state.writes).toEqual([]);
		}
	});
	test("complete list scan handles the maximum and fails closed above it", async () => {
		for (const count of [50, 51]) {
			const f = createFixture(
				Array.from({ length: count }, (_, i) => ({
					number: i + 1,
					title: i === count - 1 ? "Plan" : `Other${i}`,
				})),
			);
			f.state.pages = true;
			const result = boardCreate.run(createInput(), f.ctx);
			if (count === 50)
				expect(await result).toMatchObject({ changed: false, number: 50 });
			else await expect(result).rejects.toMatchObject({ code: "api" });
			expect(f.state.writes).toEqual([]);
		}
	});

	test("create and reuse plans do not write; conflicts refuse in dry-run", async () => {
		for (const open of [[], [{ number: 4, title: "Plan" }]]) {
			const f = createFixture(open);
			expect(
				await boardCreate.run(createInput("Plan", undefined, true), f.ctx),
			).toMatchObject({
				dry_run: true,
				changed: open.length === 0,
				apply: "fgj write board create Plan",
			});
			expect(f.state.writes).toEqual([]);
		}
		const f = createFixture([], [{ number: 6, title: "Plan" }]);
		await expect(
			boardCreate.run(createInput("Plan", undefined, true), f.ctx),
		).rejects.toMatchObject({ code: "conflict" });
		expect(f.state.writes).toEqual([]);
	});
});

const args = (positionals: string[], flags: Record<string, string>) =>
	({ positionals, flags }) as Parameters<typeof boardAdd.prepare>[0];

describe("board writes against a fake board", () => {
	test("move: a card that the server did not save gets its own error; a saved card in the same request reads as changed", async () => {
		const fake = fakeBoard([
			{
				id: 1,
				name: "Backlog",
				cards: [
					{ n: 5, id: 1005 },
					{ n: 6, id: 1006 },
				],
			},
			{ id: 2, name: "To Do", cards: [] },
		]);
		// The server saves only #6, as when the account lacks permission for #5.
		fake.setMove(() => {
			const [backlog, todo] = fake.state.columns as unknown as [
				{ cards: Card[] },
				{ cards: Card[] },
			];
			backlog.cards = backlog.cards.filter((k) => k.n !== 6);
			todo.cards = [{ n: 6, id: 1006 }];
		});
		const input = boardMove.prepare(args(["5", "6"], { column: "To Do" }), {
			cwd: "/",
			home: undefined,
		});
		const out = (await boardMove.run(input, fake.ctx)) as {
			changed: boolean;
			items: Record<string, unknown>[];
		};
		expect(out.changed).toBe(true);
		expect(out.items[0]).toMatchObject({ number: 5, error: { code: "api" } });
		expect(out.items[1]).toEqual({ number: 6, changed: true, column: "To Do" });
	});

	test("add: when the add saves and the move fails, the error says the issue is on the project", async () => {
		const fake = fakeBoard([
			{ id: 1, name: "Backlog", cards: [] },
			{ id: 2, name: "To Do", cards: [] },
		]);
		fake.setMove(() => {
			throw new FgjError("api", "HTTP 502", "fgj help");
		});
		const input = boardAdd.prepare(args(["7", "8"], { column: "To Do" }), {
			cwd: "/",
			home: undefined,
		});
		const out = (await boardAdd.run(input, fake.ctx)) as {
			items: { error: { code: string; message: string } }[];
		};
		for (const item of out.items) {
			expect(item.error.code).toBe("api");
			expect(item.error.message).toContain(
				"is now on project 4, column Backlog",
			);
			expect(item.error.message).toContain("HTTP 502");
		}
		expect(fake.state.posts).toEqual([
			"/o/r/issues/projects",
			"/o/r/projects/4/2/move",
		]);
	});

	test("move reads the board again just before the move, so it does not undo another agent's move", async () => {
		const fake = fakeBoard([
			{ id: 1, name: "Backlog", cards: [{ n: 5, id: 1005 }] },
			{ id: 2, name: "To Do", cards: [{ n: 9, id: 1009 }] },
			{ id: 3, name: "Done", cards: [] },
		]);
		// After fgj's scan, another agent moves #9 from To Do to Done.
		fake.state.onRead = (count) => {
			if (count !== 2) return;
			const [, todo, done] = fake.state.columns as unknown as [
				{ cards: Card[] },
				{ cards: Card[] },
				{ cards: Card[] },
			];
			todo.cards = [];
			done.cards = [{ n: 9, id: 1009 }];
		};
		fake.setMove((ids, column) => {
			for (const c of fake.state.columns) {
				c.cards = c.cards.filter((k) => !ids.includes(k.id));
			}
			const target = fake.state.columns.find((c) => c.id === column);
			if (target) target.cards = ids.map((id) => ({ n: id - 1000, id }));
		});
		const input = boardMove.prepare(args(["5"], { column: "To Do" }), {
			cwd: "/",
			home: undefined,
		});
		expect(await boardMove.run(input, fake.ctx)).toMatchObject({
			changed: true,
			column: "To Do",
		});
		expect(fake.state.bodies).toEqual([
			{ issues: [{ issueID: 1005, sorting: 0 }] },
		]);
	});

	test("move: a card that left the project during the call is a conflict, and fgj sends no empty move", async () => {
		const fake = fakeBoard([
			{ id: 1, name: "Backlog", cards: [{ n: 5, id: 1005 }] },
			{ id: 2, name: "To Do", cards: [] },
		]);
		fake.state.onRead = (count) => {
			if (count === 2) (fake.state.columns[0] as { cards: Card[] }).cards = [];
		};
		const input = boardMove.prepare(args(["5"], { column: "To Do" }), {
			cwd: "/",
			home: undefined,
		});
		await expect(boardMove.run(input, fake.ctx)).rejects.toMatchObject({
			code: "conflict",
		});
		expect(fake.state.posts).toEqual([]);
	});

	test("add: a card that the server skipped gets its own error, not the move's", async () => {
		const fake = fakeBoard([
			{ id: 1, name: "Backlog", cards: [] },
			{ id: 2, name: "To Do", cards: [] },
		]);
		// The add route skips #8 silently, as for an issue the account cannot change.
		const post = fake.ctx.web().post.bind(fake.ctx.web());
		(fake.ctx.web() as { post: typeof post }).post = async (path, body) => {
			if (path === "/o/r/issues/projects" && "form" in body) {
				return post(path, { form: { ...body.form, issue_ids: "1007" } });
			}
			return post(path, body);
		};
		fake.setMove(() => {
			throw new FgjError("api", "HTTP 502", "fgj help");
		});
		const input = boardAdd.prepare(args(["7", "8"], { column: "To Do" }), {
			cwd: "/",
			home: undefined,
		});
		const out = (await boardAdd.run(input, fake.ctx)) as {
			items: { error: { message: string } }[];
		};
		expect(out.items[0]?.error.message).toContain("is not confirmed: HTTP 502");
		expect(out.items[1]?.error.message).toContain(
			"does not show issue 8 on project 4",
		);
	});
});

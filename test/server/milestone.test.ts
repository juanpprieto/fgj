import { beforeAll, describe, expect, test } from "bun:test";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	adminApi,
	adminSend,
	createIssue,
	createPull,
	createRepo,
	expectError,
	expectOk,
	type FixtureRepo,
	httpCalls,
	loadServer,
	makeWorkDir,
	onlyGets,
	runFgj,
	type TestServer,
} from "../support/forgejo.ts";

interface StoredMilestone {
	id: number;
	title: string;
	description: string;
	state: string;
	open_issues: number;
	closed_issues: number;
	due_on: string | null;
}

interface Written {
	changed: boolean;
	id?: number;
	title?: string;
	dry_run?: true;
	apply?: string;
	as: string;
}

interface Listed {
	items: Record<string, unknown>[];
	total: number;
	next: string | null;
	as: string;
}

describe("fgj milestone verbs", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await loadServer();
	});

	/** A new repository, a work dir with it as origin, and milestone helpers. */
	const setup = async (repo?: FixtureRepo) => {
		const r = repo ?? (await createRepo(server));
		const cwd = await makeWorkDir(server, r);
		const base = `/repos/${r.owner}/${r.name}/milestones`;
		const stored = () =>
			adminApi<StoredMilestone[]>(server, `${base}?state=all&limit=50`);
		const make = async (title: string, description = "") =>
			(await adminApi<StoredMilestone>(server, base, { title, description }))
				.id;
		const close = (id: number) =>
			adminSend(server, "PATCH", `${base}/${id}`, { state: "closed" });
		const fgj = (...argv: string[]) => runFgj(server, argv, cwd);
		const list = async (...argv: string[]) =>
			expectOk<Listed>(await fgj("read", "milestone", "list", ...argv));
		return { repo: r, cwd, stored, make, close, fgj, list };
	};

	test("create makes an open milestone with no deadline, list shows it, and a repeat changes nothing", async () => {
		const { stored, fgj, list } = await setup();
		const create = (title: string) =>
			fgj(
				"write",
				"milestone",
				"create",
				"--title",
				title,
				"--description",
				"Find any note in two seconds",
			);
		const out = await expectOk<Written>(await create("Search"));
		const saved = (await stored())[0] as StoredMilestone;
		expect(out).toEqual({
			changed: true,
			id: saved.id,
			title: "Search",
			as: "env",
		});
		expect(saved).toMatchObject({
			title: "Search",
			description: "Find any note in two seconds",
			state: "open",
			due_on: null,
		});
		for (const title of ["Search", "search"]) {
			const again = await create(title);
			expect(await expectOk<Written>(again)).toEqual({
				changed: false,
				id: saved.id,
				title: "Search",
				as: "env",
			});
			expect(onlyGets(again)).toBe(true);
		}
		expect(await stored()).toHaveLength(1);
		const listed = await fgj("read", "milestone", "list");
		expect(await expectOk<Listed>(listed)).toEqual({
			items: [
				{
					id: saved.id,
					title: "Search",
					state: "open",
					open_issues: 0,
					closed_issues: 0,
					description: "Find any note in two seconds",
				},
			],
			total: 1,
			next: null,
			as: "env",
		});
		expect(onlyGets(listed)).toBe(true);
		expect((await list("--fields", "title")).items).toEqual([
			{ title: "Search" },
		]);
	});

	test("create refuses another description, a closed match, and a shared title, and writes nothing", async () => {
		const { stored, make, close, fgj } = await setup();
		await make("Search", "Old words");
		const old = await make("Old");
		await close(old);
		await make("Dup");
		await make("Dup");
		// Forgejo changes updated_at a moment after a state change, so compare
		// only what a create could change.
		const saved = async () =>
			(await stored()).map(({ id, title, description, state }) => ({
				id,
				title,
				description,
				state,
			}));
		const before = await saved();
		const create = (...argv: string[]) =>
			fgj("write", "milestone", "create", ...argv);
		const other = await create("--title", "search", "--description", "New");
		expect((await expectError(other, "conflict", 5)).message).toContain(
			"Old words",
		);
		const closed = await create("--title", "Old");
		expect((await expectError(closed, "conflict", 5)).hint).toBe(
			`fgj write milestone reopen ${old}`,
		);
		const shared = await create("--title", "Dup");
		await expectError(shared, "conflict", 5);
		// A title wins over an id, so this title would hide the milestone "Old".
		const hides = await create("--title", String(old));
		expect((await expectError(hides, "conflict", 5)).message).toContain(
			'"Old"',
		);
		for (const r of [other, closed, shared, hides]) {
			expect(onlyGets(r)).toBe(true);
		}
		expect(await saved()).toEqual(before);
	});

	test("create checks the title and the description before any request", async () => {
		const { fgj } = await setup();
		for (const argv of [
			["--title", "x".repeat(51)],
			["--title", "None"],
			["--title", "Search", "--description", "none"],
			["Search"],
		]) {
			const result = await fgj("write", "milestone", "create", ...argv);
			await expectError(result, "usage", 2);
			expect(httpCalls(result)).toEqual([]);
		}
	});

	test("--dry-run create writes nothing and gives the apply command", async () => {
		const { stored, fgj } = await setup();
		const result = await fgj(
			"write",
			"milestone",
			"create",
			"--title",
			"Plan",
			"--dry-run",
		);
		expect(await expectOk<Written>(result)).toEqual({
			dry_run: true,
			changed: true,
			title: "Plan",
			apply: "fgj write milestone create --title Plan",
			as: "env",
		});
		expect(onlyGets(result)).toBe(true);
		expect(await stored()).toEqual([]);
	});

	test("description file preserves text, dry run, retries, and refuses conflicting or invalid input", async () => {
		const { cwd, make, stored, fgj } = await setup();
		const id = await make("Parking", "Original goal");
		const file = join(cwd, "description.md");
		const content = "Keep the goal.\r\n\r\nParked: Finish search first.\r\n";
		try {
			await writeFile(file, content);
			const edit = (...extra: string[]) =>
				fgj(
					"write",
					"milestone",
					"edit",
					String(id),
					"--description-file",
					file,
					...extra,
				);
			const dry = await expectOk<Written>(await edit("--dry-run"));
			expect(dry.apply).toContain("--description-file");
			expect((await stored()).find((m) => m.id === id)?.description).toBe(
				"Original goal",
			);
			expect((await expectOk<Written>(await edit())).changed).toBe(true);
			expect((await stored()).find((m) => m.id === id)?.description).toBe(
				content,
			);
			expect((await expectOk<Written>(await edit())).changed).toBe(false);
			await expectError(
				await edit("--description", "Another goal"),
				"usage",
				2,
			);
			await writeFile(file, "none");
			await expectOk(await edit());
			expect((await stored()).find((m) => m.id === id)?.description).toBe(
				"none",
			);
			await writeFile(file, "");
			await expectOk(await edit());
			expect((await stored()).find((m) => m.id === id)?.description).toBe("");
			await writeFile(file, new Uint8Array([255]));
			await expectError(await edit(), "usage", 2);
			await writeFile(file, "bad\0text");
			await expectError(await edit(), "usage", 2);
		} finally {
			await unlink(file);
		}
	});

	test("edit changes only the given fields, none clears the description, and a taken title is a conflict", async () => {
		const { stored, make, fgj } = await setup();
		const id = await make("Search", "First words");
		await make("Other");
		const edit = (...argv: string[]) =>
			fgj("write", "milestone", "edit", ...argv);
		expect(
			await expectOk<Written>(await edit("Search", "--title", "Find")),
		).toEqual({ changed: true, id, as: "env" });
		expect((await stored()).find((m) => m.id === id)).toMatchObject({
			title: "Find",
			description: "First words",
			state: "open",
			due_on: null,
		});
		await expectOk(await edit("Find", "--description", "none"));
		expect((await stored()).find((m) => m.id === id)?.description).toBe("");
		const repeat = await edit(String(id), "--description", "none");
		expect(await expectOk<Written>(repeat)).toEqual({
			changed: false,
			id,
			as: "env",
		});
		expect(onlyGets(repeat)).toBe(true);
		const taken = await edit("Find", "--title", "other");
		await expectError(taken, "conflict", 5);
		expect(onlyGets(taken)).toBe(true);
		const nothing = await edit("Find");
		await expectError(nothing, "usage", 2);
		expect(httpCalls(nothing)).toEqual([]);
	});

	test("close and reopen change the state once, and the list filters by state", async () => {
		const { make, fgj, list } = await setup();
		const id = await make("Search");
		const close = await fgj("write", "milestone", "close", "Search");
		expect(await expectOk<Written>(close)).toEqual({
			changed: true,
			id,
			as: "env",
		});
		const again = await fgj("write", "milestone", "close", "Search");
		expect((await expectOk<Written>(again)).changed).toBe(false);
		expect(onlyGets(again)).toBe(true);
		expect((await list()).items).toEqual([]);
		expect(
			(await list("--state", "closed")).items.map((m) => [m.title, m.state]),
		).toEqual([["Search", "closed"]]);
		const reopen = await fgj("write", "milestone", "reopen", String(id));
		expect((await expectOk<Written>(reopen)).changed).toBe(true);
		expect((await list()).items.map((m) => m.title)).toEqual(["Search"]);
	});

	test("a milestone argument is the exact title, then the title without case, then the id", async () => {
		const { repo, make, fgj } = await setup();
		const alpha = await make("Alpha");
		const lower = await make("alpha");
		const beta = await make("Beta");
		const gamma = await make("Gamma");
		// A title that is another milestone's id: the title wins.
		const digits = await make(String(gamma));
		await make("Dup");
		await make("Dup");
		const n = await createIssue(server, repo, "Target");
		const milestoneOf = async () =>
			(
				await adminApi<{ milestone: { id: number } | null }>(
					server,
					`/repos/${repo.owner}/${repo.name}/issues/${n}`,
				)
			).milestone?.id;
		const set = (arg: string) =>
			fgj("write", "issue", "edit", String(n), "--milestone", arg);
		for (const [arg, want] of [
			["Alpha", alpha],
			["alpha", lower],
			["beta", beta],
			[String(beta), beta],
			[String(gamma), digits],
		] as const) {
			await expectOk(await set(arg));
			expect(await milestoneOf()).toBe(want);
		}
		const both = await set("ALPHA");
		expect((await expectError(both, "usage", 2)).message).toContain(
			`${alpha}, ${lower}`,
		);
		await expectError(await set("Dup"), "usage", 2);
		const unknown = await set("Nope");
		expect((await expectError(unknown, "not_found", 4)).hint).toBe(
			"fgj read milestone list --state all",
		);
		for (const r of [both, unknown]) expect(onlyGets(r)).toBe(true);
		expect(await milestoneOf()).toBe(digits);
	});

	test("list counts issues and pull requests at once, even when a title is another milestone's id", async () => {
		const pull = await createPull(server);
		const { repo, make, fgj, list } = await setup(pull.repo);
		const beta = await make("Beta");
		const digits = await make(String(beta));
		await adminApi(server, `/repos/${repo.owner}/${repo.name}/issues`, {
			title: "In beta",
			milestone: beta,
		});
		const n = await createIssue(server, repo, "Moved");
		await expectOk(
			await fgj(
				"write",
				"issue",
				"edit",
				String(n),
				String(pull.number),
				"--milestone",
				String(digits),
			),
		);
		await adminSend(
			server,
			"PATCH",
			`/repos/${repo.owner}/${repo.name}/issues/${n}`,
			{ state: "closed" },
		);
		const counts = Object.fromEntries(
			(await list()).items.map((m) => [m.id, [m.open_issues, m.closed_issues]]),
		);
		expect(counts).toEqual({ [beta]: [1, 0], [digits]: [1, 1] });
	});

	test("list pages with --limit, and next is the exact command for the rest", async () => {
		const { make, list } = await setup();
		for (const title of ["One", "Two", "Three"]) await make(title);
		const first = await list("--limit", "2", "--fields", "title");
		expect(first.items).toHaveLength(2);
		expect(first.total).toBe(3);
		expect(first.next).toBe(
			"fgj read milestone list --fields title --limit 2 --offset 2",
		);
		const rest = await list(
			"--limit",
			"2",
			"--fields",
			"title",
			"--offset",
			"2",
		);
		expect(rest.items).toHaveLength(1);
		expect(rest.next).toBeNull();
	});
});

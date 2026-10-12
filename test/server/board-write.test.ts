import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	addToProject,
	adminApi,
	adminSend,
	adminWeb,
	closeProject,
	createIssue,
	createOwnerProject,
	createProject,
	createRepo,
	createUser,
	deleteOwnerProject,
	expectError,
	expectOk,
	httpCalls,
	loadServer,
	makeWorkDir,
	mintToken,
	moveCards,
	runFgj,
	type TestServer,
	webProfile,
	withProjectTemplates,
} from "../support/forgejo.ts";

interface CreatedBoard {
	changed: boolean;
	number: number;
	url?: string;
	project: string;
	columns: string[];
	as: string;
}

/** Reads saved column names independently of the fgj parser. */
async function savedColumns(
	server: TestServer,
	path: string,
): Promise<string[]> {
	const html = await adminWeb(server, path);
	const columns: string[] = [];
	let name = "";
	await new HTMLRewriter()
		.on(".project-column-title-label", {
			element(e) {
				name = "";
				e.onEndTag(() => {
					columns.push(name.trim());
				});
			},
			text(t) {
				name += t.text;
			},
		})
		.transform(new Response(html))
		.text();
	return columns;
}

describe("board create acceptance", () => {
	let server: TestServer;
	beforeAll(async () => {
		server = await loadServer();
	});
	const fixture = async () => {
		const repo = await createRepo(server);
		const cwd = await makeWorkDir(server, repo);
		await webProfile(server, cwd);
		return { repo, cwd, base: `/${repo.owner}/${repo.name}/projects` };
	};
	const run = (cwd: string, ...args: string[]) =>
		runFgj(server, ["write", "board", "create", ...args], cwd, {
			FGJ_PROFILE: "t",
		});
	const posts = (r: { trace: string }) =>
		httpCalls(r).filter((c) => c.startsWith("POST"));
	test("default creates one board and repeat reuses saved columns", async () => {
		const { cwd, base } = await fixture();
		const result = await run(cwd, "Onboarding");
		const out = await expectOk<CreatedBoard>(result);
		expect(out).toEqual({
			changed: true,
			number: expect.any(Number),
			url: `${server.url}${base}/${out.number}`,
			project: "Onboarding",
			columns: ["Backlog", "To Do", "In Progress", "Done"],
			as: "t",
		});
		expect(out.columns).toEqual(
			await savedColumns(server, `${base}/${out.number}`),
		);
		expect(posts(result)).toEqual([`POST ${base}/new`]);
		const repeat = await run(cwd, "onboarding", "--template", "none");
		expect(await expectOk<CreatedBoard>(repeat)).toEqual({
			changed: false,
			number: out.number,
			project: out.project,
			columns: out.columns,
			as: out.as,
		});
		expect(posts(repeat)).toEqual([]);
	}, 30000);
	test.each([
		["emoji 256 bytes", "😀".repeat(64)],
		["CJK 256 bytes", `${"界".repeat(85)}a`],
		["emoji100", "😀".repeat(100)],
		["CJK100", "界".repeat(100)],
	])(
		"UTF-8 refusal is repeat safe: %s",
		async (_label, name) => {
			const { cwd, base } = await fixture();
			const links = (html: string) =>
				html.match(/href="[^"]*\/projects\/\d+"/g) ?? [];
			const before = links(await adminWeb(server, base));
			expect(before).toEqual([]);
			for (const extra of [[], [], ["--dry-run"]]) {
				const result = await run(cwd, name, ...extra);
				const error = await expectError(result, "usage", 2);
				expect(error.message).toContain("255 UTF-8 bytes");
				expect(result.stdout).toBe("");
				expect(httpCalls(result)).toEqual([]);
				expect(links(await adminWeb(server, base))).toEqual(before);
			}
		},
		30000,
	);
	test.each([
		["emoji 255 bytes", `${"😀".repeat(63)}abc`, 255],
		["CJK 255 bytes", "界".repeat(85), 255],
		["ASCII100", "a".repeat(100), 100],
		["accented100", "é".repeat(100), 200],
		["decomposed100", "e\u0301".repeat(50), 150],
		["short emoji", "😀", 4],
		["quoted text", 'Quoted & <angle> "Ω"', 21],
	])(
		"UTF-8 passing control creates once and reuses: %s",
		async (_label, name, bytes) => {
			expect(new Blob([name]).size).toBe(bytes);
			const { cwd, base } = await fixture();
			const first = await run(cwd, name);
			const out = await expectOk<CreatedBoard>(first);
			expect(out).toMatchObject({ changed: true, project: name });
			expect(posts(first)).toEqual([`POST ${base}/new`]);
			const read = () =>
				runFgj(
					server,
					["read", "board", "list", "--project", String(out.number)],
					cwd,
					{ FGJ_PROFILE: "t" },
				);
			const before = await expectOk<BoardOut>(await read());
			expect(before.project).toBe(name);
			expect(out.columns).toEqual(
				await savedColumns(server, `${base}/${out.number}`),
			);
			for (const extra of [["--template", "none"], ["--dry-run"]]) {
				const repeat = await run(cwd, name, ...extra);
				expect(await expectOk<CreatedBoard>(repeat)).toMatchObject({
					changed: false,
					number: out.number,
					project: name,
					columns: out.columns,
				});
				expect(posts(repeat)).toEqual([]);
				expect(await expectOk<BoardOut>(await read())).toEqual(before);
				const inventory = await adminWeb(server, base);
				expect(inventory.match(/href="[^"]*\/projects\/\d+"/g)).toEqual([
					`href="${base}/${out.number}"`,
				]);
			}
		},
		30000,
	);
	test("all released templates return independently saved columns", async () => {
		const { cwd, base } = await fixture();
		for (const [template, columns] of [
			["none", []],
			["basic-kanban", ["Backlog", "To Do", "In Progress", "Done"]],
			[
				"bug-triage",
				["Backlog", "Needs Triage", "High Priority", "Low Priority", "Closed"],
			],
		] as const) {
			const out = await expectOk<CreatedBoard>(
				await run(cwd, template, "--template", template),
			);
			expect(out.columns).toEqual([...columns]);
			expect(out.columns).toEqual(
				await savedColumns(server, `${base}/${out.number}`),
			);
		}
	}, 30000);
	test("both server-configured templates return saved names without workflow policy", async () => {
		await withProjectTemplates(async (configured) => {
			const repo = await createRepo(configured);
			const cwd = await makeWorkDir(configured, repo);
			await webProfile(configured, cwd);
			for (const [template, columns] of [
				["basic-kanban", ["Backlog", "Ready", "Review", "Released"]],
				["bug-triage", ["Backlog", "Inspect", "Repair", "Verified"]],
			] as const) {
				const out = await expectOk<CreatedBoard>(
					await runFgj(
						configured,
						["write", "board", "create", template, "--template", template],
						cwd,
						{ FGJ_PROFILE: "t" },
					),
				);
				expect(out.columns).toEqual([...columns]);
				expect(out.columns).toEqual(
					await savedColumns(
						configured,
						`/${repo.owner}/${repo.name}/projects/${out.number}`,
					),
				);
			}
		});
	}, 120000);

	test("accepted write response loss and failed or malformed read-back never repeat creation", async () => {
		for (const fault of ["response", "read", "malformed"]) {
			const repo = await createRepo(server);
			const base = `/${repo.owner}/${repo.name}/projects`;
			let writes = 0;
			const proxy = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				async fetch(req) {
					const url = new URL(req.url);
					if (
						writes > 0 &&
						req.method === "GET" &&
						new RegExp(`${base}/\\d+$`).test(url.pathname) &&
						fault !== "response"
					)
						return new Response(
							fault === "malformed"
								? '<div class="view-project" aria-label="Plan"><div id="project-board"><div class="project-column" data-id="bad"></div></div></div>'
								: "read-back unavailable",
							{ status: fault === "read" ? 503 : 200 },
						);
					const res = await fetch(`${server.url}${url.pathname}${url.search}`, {
						method: req.method,
						headers: req.headers,
						redirect: "manual",
						...(req.method === "POST" ? { body: await req.text() } : {}),
					});
					if (req.method === "POST" && url.pathname === `${base}/new`) {
						writes++;
						expect(res.status).toBe(303);
						if (fault === "response") {
							await res.body?.cancel();
							return Response.error();
						}
					}
					return res;
				},
			});
			try {
				const proxied = { ...server, url: `http://127.0.0.1:${proxy.port}` };
				const cwd = await makeWorkDir(proxied, repo);
				await webProfile(proxied, cwd);
				const result = await runFgj(
					proxied,
					["write", "board", "create", "Plan"],
					cwd,
					{ FGJ_PROFILE: "t" },
				);
				await expectError(result, "api", 1);
				expect(writes).toBe(1);
				expect(result.stdout).toBe("");
				const inventory = await adminWeb(server, base);
				expect([...inventory.matchAll(/>Plan<\/a>/g)]).toHaveLength(1);
			} finally {
				proxy.stop(true);
			}
		}
	}, 30000);

	test("reuse with closed companion and different template preserves cards and columns", async () => {
		const { cwd, repo, base } = await fixture();
		const open = await createProject(server, repo, "Plan");
		const closed = await createProject(server, repo, "PLAN");
		await closeProject(server, repo, closed.number);
		await createIssue(server, repo, "Card");
		await addToProject(server, repo, open.number, [1]);
		const before = await expectOk<BoardOut>(
			await runFgj(
				server,
				["read", "board", "list", "--project", String(open.number)],
				cwd,
				{ FGJ_PROFILE: "t" },
			),
		);
		const result = await run(cwd, "plan", "--template", "none");
		expect(await expectOk(result)).toMatchObject({
			changed: false,
			number: open.number,
		});
		expect(posts(result)).toEqual([]);
		expect(
			await expectOk<BoardOut>(
				await runFgj(
					server,
					["read", "board", "list", "--project", String(open.number)],
					cwd,
					{ FGJ_PROFILE: "t" },
				),
			),
		).toEqual(before);
		expect(await adminWeb(server, `${base}?state=closed`)).toContain(
			`${base}/${closed.number}`,
		);
	}, 30000);
	test("ambiguous and closed-only refuse without changing inventory, including dry-run", async () => {
		for (const closedOnly of [false, true]) {
			const { cwd, repo, base } = await fixture();
			const a = await createProject(server, repo, "Plan");
			const b = await createProject(server, repo, "plan");
			if (closedOnly) {
				await closeProject(server, repo, a.number);
				await closeProject(server, repo, b.number);
			}
			const before = await adminWeb(
				server,
				`${base}?state=${closedOnly ? "closed" : "open"}`,
			);
			for (const extra of [[], ["--dry-run"]]) {
				const result = await run(cwd, "Plan", ...extra);
				const error = await expectError(result, "conflict", 5);
				expect(error.message).toContain(String(a.number));
				expect(error.message).toContain(String(b.number));
				expect(posts(result)).toEqual([]);
			}
			// Session headers can change; compare the board links instead of page bytes.
			const links = (html: string) =>
				html.match(/href="[^"]*\/projects\/\d+"/g);
			expect(
				links(
					await adminWeb(
						server,
						`${base}?state=${closedOnly ? "closed" : "open"}`,
					),
				),
			).toEqual(links(before));
		}
	}, 30000);
	test("invalid argv and missing, expired, revoked login fail closed", async () => {
		const { cwd, base } = await fixture();
		for (const argv of [
			[],
			[""],
			[" "],
			["x".repeat(101)],
			["Plan", "--template"],
			["Plan", "--template", "unknown"],
		]) {
			const result = await run(cwd, ...argv);
			await expectError(result, "usage", 2);
			expect(httpCalls(result)).toEqual([]);
		}
		const file = join(cwd, ".config", "fgj", "hosts.json");
		const store = JSON.parse(await Bun.file(file).text());
		for (const mode of ["missing", "expired", "revoked"]) {
			const bad = structuredClone(store);
			if (mode === "missing") delete bad.profiles.t.web;
			else if (mode === "expired")
				bad.profiles.t.web.expires = "2000-01-01T00:00:00Z";
			else bad.profiles.t.web.value = "revoked-cookie";
			await Bun.write(file, JSON.stringify(bad));
			const result = await run(cwd, "Plan");
			const error = await expectError(result, "auth", 3);
			expect(error.hint).toContain("fgj auth web");
			expect(posts(result)).toEqual([]);
			expect(result.stderr).not.toContain(store.profiles.t.web.value);
		}
		expect(await adminWeb(server, base)).not.toContain("Plan</a>");
	}, 30000);
	test("Projects read-only, disabled, and archived repositories create no board", async () => {
		for (const mode of ["read-only", "disabled", "archived"]) {
			const { cwd, repo, base } = await fixture();
			if (mode === "read-only") {
				const user = await createUser(server);
				await adminSend(
					server,
					"PUT",
					`/repos/${repo.owner}/${repo.name}/collaborators/${user.username}`,
					{ permission: "read" },
				);
				await webProfile(server, cwd, {
					login: user,
					tokens: {
						read: await mintToken(server, user, [
							"read:repository",
							"read:issue",
							"read:user",
						]),
						write: await mintToken(server, user, [
							"write:repository",
							"write:issue",
							"read:user",
						]),
					},
				});
			} else
				await adminSend(
					server,
					"PATCH",
					`/repos/${repo.owner}/${repo.name}`,
					mode === "disabled" ? { has_projects: false } : { archived: true },
				);
			const result = await run(cwd, "Plan");
			expect(result.code).not.toBe(0);
			expect(result.stderr).toMatch(
				/permission|Projects|projects|archived|404/,
			);
			if (mode !== "disabled")
				expect(await adminWeb(server, base)).not.toContain("Plan</a>");
		}
	}, 30000);
	test("create and reuse dry-run never POST; wrong risk refuses before network", async () => {
		const { cwd, base } = await fixture();
		const dry = await run(cwd, "Plan", "--dry-run");
		expect(await expectOk(dry)).toMatchObject({
			dry_run: true,
			changed: true,
			template: "basic-kanban",
		});
		expect(posts(dry)).toEqual([]);
		expect(await adminWeb(server, base)).not.toContain("Plan</a>");
		await expectOk(await run(cwd, "Plan"));
		const reuse = await run(cwd, "Plan", "--dry-run");
		expect(await expectOk(reuse)).toMatchObject({
			dry_run: true,
			changed: false,
		});
		expect(posts(reuse)).toEqual([]);
		for (const risk of ["read", "destroy"]) {
			const r = await runFgj(server, [risk, "board", "create", "Plan"], cwd, {
				FGJ_PROFILE: "t",
			});
			await expectError(r, "risk_mismatch", 6);
			expect(httpCalls(r)).toEqual([]);
		}
	}, 30000);
});

interface BoardOut {
	project: string;
	columns: { name: string; issues: number[] }[];
}

describe("fgj write board add and board move", () => {
	let server: TestServer;
	const as = { FGJ_PROFILE: "t" };

	beforeAll(async () => {
		server = await loadServer();
	});

	/** A repository with issues 1..n, one project with the kanban columns, and a work dir. */
	const fixture = async (issues: number) => {
		const repo = await createRepo(server);
		for (let i = 1; i <= issues; i++) await createIssue(server, repo, `I${i}`);
		const project = await createProject(server, repo, "Plan");
		const cwd = await makeWorkDir(server, repo);
		await webProfile(server, cwd);
		return { repo, project, cwd };
	};

	const fgj = (cwd: string, ...argv: string[]) => runFgj(server, argv, cwd, as);

	const board = async (cwd: string) => {
		const out = await expectOk<BoardOut>(
			await fgj(cwd, "read", "board", "list"),
		);
		return Object.fromEntries(out.columns.map((c) => [c.name, c.issues]));
	};

	const posts = (r: { trace: string }) =>
		httpCalls(r).filter((c) => c.startsWith("POST"));

	test("move puts the card at the bottom, keeps the other cards' order, and a repeat is changed:false", async () => {
		const { repo, project, cwd } = await fixture(4);
		await addToProject(server, repo, project.number, [1, 2, 3, 4]);
		await moveCards(
			server,
			repo,
			project.number,
			project.columns["To Do"],
			[3, 1],
		);
		const result = await fgj(
			cwd,
			"write",
			"board",
			"move",
			"2",
			"--column",
			"to do",
		);
		expect(await expectOk<unknown>(result)).toEqual({
			changed: true,
			number: 2,
			column: "To Do",
			as: "t",
		});
		expect(posts(result)).toEqual([
			`POST /${repo.owner}/${repo.name}/projects/${project.number}/${project.columns["To Do"]}/move`,
		]);
		// A fresh read just before the move, and a read-back after it.
		const boardPath = `GET /${repo.owner}/${repo.name}/projects/${project.number}`;
		const calls = httpCalls(result);
		const post = calls.findIndex((c) => c.startsWith("POST"));
		expect(calls[post - 1]).toBe(boardPath);
		expect(calls[post + 1]).toBe(boardPath);
		expect(await board(cwd)).toMatchObject({
			Backlog: [4],
			"To Do": [3, 1, 2],
		});
		const again = await fgj(
			cwd,
			"write",
			"board",
			"move",
			"2",
			"--column",
			"To Do",
		);
		expect(await expectOk<unknown>(again)).toMatchObject({ changed: false });
		expect(posts(again)).toEqual([]);
	}, 30_000);

	test("move of many issues: one request per board, results in argument order, --dry-run sends nothing", async () => {
		const { repo, project, cwd } = await fixture(3);
		await addToProject(server, repo, project.number, [1, 2, 3]);
		const dry = await fgj(
			cwd,
			"write",
			"board",
			"move",
			"3",
			"1",
			"--column",
			"Done",
			"--dry-run",
		);
		expect(await expectOk<unknown>(dry)).toEqual({
			dry_run: true,
			changed: true,
			items: [
				{ number: 3, changed: true, column: "Done" },
				{ number: 1, changed: true, column: "Done" },
			],
			apply: "fgj write board move 3 1 --column Done",
			as: "t",
		});
		expect(posts(dry)).toEqual([]);
		const real = await fgj(
			cwd,
			"write",
			"board",
			"move",
			"3",
			"1",
			"--column",
			"Done",
		);
		expect(posts(real)).toHaveLength(1);
		expect(await board(cwd)).toMatchObject({ Backlog: [2], Done: [3, 1] });
	}, 30_000);

	test("move: an issue on no project is a conflict with a board add hint; a missing issue is not_found; the exit code is the first failure's", async () => {
		const { repo, project, cwd } = await fixture(3);
		await addToProject(server, repo, project.number, [1]);
		const one = await expectError(
			await fgj(cwd, "write", "board", "move", "2", "--column", "Done"),
			"conflict",
			5,
		);
		expect(one.hint).toBe("fgj write board add 2 --column Done");
		const many = await fgj(
			cwd,
			"write",
			"board",
			"move",
			"1",
			"99",
			"2",
			"--column",
			"Done",
		);
		expect(many.code).toBe(4);
		const out = JSON.parse(many.stdout);
		expect(out.changed).toBe(true);
		expect(out.items[0]).toEqual({ number: 1, changed: true, column: "Done" });
		expect(out.items[1].error.code).toBe("not_found");
		expect(out.items[2].error.code).toBe("conflict");
		const col = await expectError(
			await fgj(cwd, "write", "board", "move", "1", "--column", "Doing"),
			"usage",
			2,
		);
		expect(col.message).toContain("Backlog, To Do, In Progress, Done");
		expect(col.hint).toBe(`fgj read board list --project ${project.number}`);
		await expectError(
			await fgj(cwd, "write", "board", "move", "1"),
			"usage",
			2,
		);
	}, 30_000);

	test("add without --column: the default column; a repeat is changed:false; --dry-run sends nothing", async () => {
		const { cwd } = await fixture(2);
		const dry = await fgj(cwd, "write", "board", "add", "1", "--dry-run");
		expect(await expectOk<unknown>(dry)).toMatchObject({
			dry_run: true,
			changed: true,
			number: 1,
		});
		expect(posts(dry)).toEqual([]);
		const first = await expectOk<{ changed: boolean; column: string }>(
			await fgj(cwd, "write", "board", "add", "1"),
		);
		expect(first.changed).toBe(true);
		const shown = await board(cwd);
		expect(shown[first.column]).toEqual([1]);
		const again = await fgj(cwd, "write", "board", "add", "1");
		expect(await expectOk<unknown>(again)).toMatchObject({
			changed: false,
			column: first.column,
		});
		expect(posts(again)).toEqual([]);
	}, 30_000);

	test("add --column puts new cards at the bottom in argument order, and moves a card already on the project", async () => {
		const { repo, project, cwd } = await fixture(5);
		await addToProject(server, repo, project.number, [1, 2]);
		await moveCards(
			server,
			repo,
			project.number,
			project.columns["To Do"],
			[2],
		);
		const result = await fgj(
			cwd,
			"write",
			"board",
			"add",
			"4",
			"3",
			"1",
			"--project",
			"plan",
			"--column",
			"To Do",
		);
		expect(await expectOk<unknown>(result)).toEqual({
			changed: true,
			items: [
				{ number: 4, changed: true, column: "To Do" },
				{ number: 3, changed: true, column: "To Do" },
				{ number: 1, changed: true, column: "To Do" },
			],
			as: "t",
		});
		expect(await board(cwd)).toMatchObject({
			Backlog: [],
			"To Do": [2, 4, 3, 1],
		});
		const again = await fgj(
			cwd,
			"write",
			"board",
			"add",
			"4",
			"--column",
			"To Do",
		);
		expect(await expectOk<unknown>(again)).toMatchObject({ changed: false });
	}, 30_000);

	test("add keeps argument order: new and existing cards mixed, and several new cards without --column", async () => {
		const { repo, project, cwd } = await fixture(6);
		await addToProject(server, repo, project.number, [1, 5]);
		await moveCards(
			server,
			repo,
			project.number,
			project.columns["To Do"],
			[5],
		);
		await expectOk(
			await fgj(
				cwd,
				"write",
				"board",
				"add",
				"1",
				"4",
				"3",
				"--column",
				"To Do",
			),
		);
		expect((await board(cwd))["To Do"]).toEqual([5, 1, 4, 3]);
		const plain = await expectOk<{ items: { column: string }[] }>(
			await fgj(cwd, "write", "board", "add", "6", "2"),
		);
		const landed = plain.items[0]?.column as string;
		expect((await board(cwd))[landed]?.slice(-2)).toEqual([6, 2]);
	}, 30_000);

	test("dry runs: add --column that would move a card, and many issues with apply", async () => {
		const { repo, project, cwd } = await fixture(3);
		await addToProject(server, repo, project.number, [1]);
		const dry = await fgj(
			cwd,
			"write",
			"board",
			"add",
			"1",
			"2",
			"--column",
			"Done",
			"--dry-run",
		);
		expect(await expectOk<unknown>(dry)).toEqual({
			dry_run: true,
			changed: true,
			items: [
				{ number: 1, changed: true, column: "Done" },
				{ number: 2, changed: true, column: "Done" },
			],
			apply: "fgj write board add 1 2 --column Done",
			as: "t",
		});
		expect(posts(dry)).toEqual([]);
		const plain = await expectOk<Record<string, unknown>>(
			await fgj(cwd, "write", "board", "add", "3", "--dry-run"),
		);
		// Without --column the server picks the column, so the dry run leaves it out.
		expect(plain).toEqual({
			changed: true,
			number: 3,
			dry_run: true,
			apply: "fgj write board add 3",
			as: "t",
		});
	}, 30_000);

	test("move across two boards sends one move per board", async () => {
		const { repo, project, cwd } = await fixture(2);
		const second = await createProject(server, repo, "Second");
		await addToProject(server, repo, project.number, [1]);
		await addToProject(server, repo, second.number, [2]);
		const result = await fgj(
			cwd,
			"write",
			"board",
			"move",
			"1",
			"2",
			"--column",
			"Done",
		);
		expect(await expectOk<unknown>(result)).toMatchObject({
			changed: true,
			items: [
				{ number: 1, changed: true, column: "Done" },
				{ number: 2, changed: true, column: "Done" },
			],
		});
		expect(posts(result)).toHaveLength(2);
	}, 30_000);

	test("--column on a board with no columns says so", async () => {
		const bare = await createRepo(server);
		await createIssue(server, bare, "Only");
		await adminWeb(server, `/${bare.owner}/${bare.name}/projects/new`, {
			form: { title: "Empty", template_type: "0", card_type: "1", content: "" },
		});
		const cwd = await makeWorkDir(server, bare);
		await webProfile(server, cwd);
		const err = await expectError(
			await fgj(cwd, "write", "board", "add", "1", "--column", "Done"),
			"usage",
			2,
		);
		expect(err.message).toBe('No column "Done": Empty has no columns.');
	}, 30_000);

	test("add: an issue on another project is a conflict that names it, and fgj sends no change", async () => {
		const { repo, project, cwd } = await fixture(2);
		const other = await createProject(server, repo, "Other");
		await addToProject(server, repo, other.number, [1]);
		const result = await fgj(
			cwd,
			"write",
			"board",
			"add",
			"1",
			"--project",
			String(project.number),
		);
		const err = await expectError(result, "conflict", 5);
		expect(err.message).toContain('"Other"');
		expect(err.hint).toBe("fgj read board card 1");
		expect(posts(result)).toEqual([]);
		await expectError(
			await fgj(
				cwd,
				"write",
				"board",
				"add",
				"99",
				"--project",
				String(project.number),
			),
			"not_found",
			4,
		);
	}, 30_000);

	test("a move on an owner board keeps the cards of other repositories in place", async () => {
		const [a, b] = [await createRepo(server), await createRepo(server)];
		await createIssue(server, a, "A1");
		await createIssue(server, b, "B1");
		const { id } = await createOwnerProject(server, "Owner");
		try {
			const done = async () => {
				const html = await adminWeb(
					server,
					`/${server.username}/-/projects/${id}`,
				);
				const at = html.indexOf(">Done<");
				const column = html.slice(
					at,
					html.indexOf('class="project-column"', at + 1),
				);
				return [...column.matchAll(/data-issue="(\d+)"/g)].map((m) =>
					Number(m[1]),
				);
			};
			const page = await adminWeb(
				server,
				`/${server.username}/-/projects/${id}`,
			);
			const columns = new Map<string, number>();
			for (const m of page.matchAll(
				/class="project-column[^"]*" data-id="(\d+)"[\s\S]*?project-column-title-label[^>]*>([^<]*)</g,
			)) {
				columns.set((m[2] as string).trim(), Number(m[1]));
			}
			const doneId = columns.get("Done");
			await addToProject(server, a, id, [1]);
			await addToProject(server, b, id, [1]);
			const bId = (
				await adminApi<{ id: number }>(
					server,
					`/repos/${b.owner}/${b.name}/issues/1`,
				)
			).id;
			const aId = (
				await adminApi<{ id: number }>(
					server,
					`/repos/${a.owner}/${a.name}/issues/1`,
				)
			).id;
			await adminWeb(
				server,
				`/${server.username}/-/projects/${id}/${doneId}/move`,
				{
					json: { issues: [{ issueID: bId, sorting: 0 }] },
				},
			);
			const dir = await makeWorkDir(server, a);
			await webProfile(server, dir);
			await expectOk(
				await fgj(dir, "write", "board", "move", "1", "--column", "Done"),
			);
			expect(await done()).toEqual([bId, aId]);
		} finally {
			await deleteOwnerProject(server, id);
		}
	});

	test("the audit log gets one line per write, with each item and no cookie", async () => {
		const { repo, project, cwd } = await fixture(2);
		await addToProject(server, repo, project.number, [1, 2]);
		await expectOk(
			await fgj(cwd, "write", "board", "move", "1", "2", "--column", "Done"),
		);
		const log = readFileSync(
			join(cwd, ".local", "state", "fgj", "audit.jsonl"),
			"utf8",
		);
		const last = JSON.parse(log.trim().split("\n").at(-1) ?? "{}");
		expect(last.result).toEqual({
			changed: true,
			items: [
				{ number: 1, changed: true },
				{ number: 2, changed: true },
			],
		});
		const store = JSON.parse(
			readFileSync(join(cwd, ".config", "fgj", "hosts.json"), "utf8"),
		);
		expect(log).not.toContain(store.profiles.t.web.value);
	}, 30_000);
});

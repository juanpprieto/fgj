import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	addComment,
	addToProject,
	adminApi,
	adminWeb,
	closeProject,
	createIssue,
	createOwnerProject,
	createProject,
	createPull,
	createRepo,
	createUser,
	deleteOwnerProject,
	expectError,
	expectOk,
	type FixtureRepo,
	httpCalls,
	loadServer,
	makeWorkDir,
	mintToken,
	moveCards,
	onlyGets,
	runFgj,
	type TestServer,
	webProfile,
} from "../support/forgejo.ts";

const READ = ["read:issue", "read:repository", "read:user"];
const WRITE = ["write:issue", "write:repository", "read:user"];

interface BoardOut {
	project: string;
	columns: { name: string; issues: number[] }[];
	as: string;
}

describe("fgj read board list and board card", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let alpha: { number: number; columns: Record<string, number> };
	let beta: { number: number; columns: Record<string, number> };
	let cwd: string;
	const as = { FGJ_PROFILE: "t" };

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		for (const t of ["One", "Two", "Three", "Four"]) {
			await createIssue(server, repo, t);
		}
		alpha = await createProject(server, repo, "Alpha board");
		beta = await createProject(server, repo, "Beta & Co");
		await addToProject(server, repo, alpha.number, [1, 2]);
		await moveCards(server, repo, alpha.number, alpha.columns["To Do"], [2]);
		await addToProject(server, repo, beta.number, [4]);
		cwd = await makeWorkDir(server, repo);
		await webProfile(server, cwd);
	}, 60_000);

	const fgj = (dir: string, ...argv: string[]) =>
		runFgj(server, ["read", "board", ...argv], dir, as);

	test("a title, in any case, reads the board: columns in order, issue numbers in each, with GET only", async () => {
		const result = await fgj(cwd, "list", "--project", "alpha BOARD");
		expect(await expectOk<BoardOut>(result)).toEqual({
			project: "Alpha board",
			columns: [
				{ name: "Backlog", issues: [1] },
				{ name: "To Do", issues: [2] },
				{ name: "In Progress", issues: [] },
				{ name: "Done", issues: [] },
			],
			as: "t",
		});
		expect(onlyGets(result)).toBe(true);
		expect(httpCalls(result)).toEqual([
			"GET /user/login",
			// No exact title is open, so an exact closed title would win: fgj checks.
			`GET /${repo.owner}/${repo.name}/projects?state=open&q=alpha+BOARD`,
			`GET /${repo.owner}/${repo.name}/projects?state=closed&q=alpha+BOARD`,
			`GET /${repo.owner}/${repo.name}/projects/${alpha.number}`,
		]);
	});

	test("a number and --column read one column; an HTML entity in a title reads as text", async () => {
		const one = await expectOk<BoardOut>(
			await fgj(
				cwd,
				"list",
				"--project",
				String(alpha.number),
				"--column",
				"to do",
			),
		);
		expect(one.columns).toEqual([{ name: "To Do", issues: [2] }]);
		const b = await expectOk<BoardOut>(
			await fgj(cwd, "list", "--project", "Beta & Co"),
		);
		expect(b.project).toBe("Beta & Co");
		expect(b.columns[0]).toEqual({ name: "Backlog", issues: [4] });
	});

	test("with two open projects and no --project, it fails with both, and the hint does not pick one", async () => {
		const err = await expectError(await fgj(cwd, "list"), "usage", 2);
		expect(err.message).toContain(`${alpha.number} (Alpha board)`);
		expect(err.message).toContain(`${beta.number} (Beta & Co)`);
		// The agent picks from the names; a hint that picks one would guess.
		expect(err.hint).toBe("fgj help board list");
	});

	test("an unknown project or column fails with the valid names", async () => {
		const p = await expectError(
			await fgj(cwd, "list", "--project", "Gamma"),
			"not_found",
			4,
		);
		expect(p.message).toContain("Alpha board");
		expect(p.message).toContain("Beta & Co");
		const n = await expectError(
			await fgj(cwd, "list", "--project", "999"),
			"not_found",
			4,
		);
		expect(n.message).toContain("No project 999");
		const c = await expectError(
			await fgj(cwd, "list", "--project", "Alpha board", "--column", "Doing"),
			"usage",
			2,
		);
		expect(c.message).toContain("Backlog, To Do, In Progress, Done");
	});

	test("with one open project, --project is optional; a closed project still reads by title", async () => {
		const solo = await createRepo(server);
		await createIssue(server, solo, "Only");
		const only = await createProject(server, solo, "Solo");
		const old = await createProject(server, solo, "Old");
		await addToProject(server, solo, only.number, [1]);
		await closeProject(server, solo, old.number);
		const dir = await makeWorkDir(server, solo);
		await webProfile(server, dir);
		const out = await expectOk<BoardOut>(await fgj(dir, "list"));
		expect(out.project).toBe("Solo");
		expect(out.columns[0]).toEqual({ name: "Backlog", issues: [1] });
		const closed = await expectOk<BoardOut>(
			await fgj(dir, "list", "--project", "old"),
		);
		expect(closed.project).toBe("Old");
	}, 30_000);

	test("a project made with no columns reads as an empty board", async () => {
		const bare = await createRepo(server);
		await adminWeb(server, `/${bare.owner}/${bare.name}/projects/new`, {
			form: { title: "Empty", template_type: "0", card_type: "1", content: "" },
		});
		const dir = await makeWorkDir(server, bare);
		await webProfile(server, dir);
		expect(await expectOk<BoardOut>(await fgj(dir, "list"))).toEqual({
			project: "Empty",
			columns: [],
			as: "t",
		});
	}, 30_000);

	test("board card finds the project and column of each issue; an issue on no project has project null", async () => {
		const result = await fgj(cwd, "card", "1", "2", "3", "4", "99");
		expect(await expectOk<unknown>(result)).toEqual({
			items: [
				{ number: 1, project: "Alpha board", column: "Backlog" },
				{ number: 2, project: "Alpha board", column: "To Do" },
				{ number: 3, project: null },
				{ number: 4, project: "Beta & Co", column: "Backlog" },
			],
			missing: [99],
			as: "t",
		});
		expect(onlyGets(result)).toBe(true);
		// Each board is read once, whatever the number of issues on it. Issue 3 is
		// on no project, so fgj also reads the owner's boards.
		const boards = httpCalls(result).filter((c) => /projects\/\d+$/.test(c));
		expect(new Set(boards).size).toBe(boards.length);
		expect(boards).toContain(
			`GET /${repo.owner}/${repo.name}/projects/${alpha.number}`,
		);
		expect(
			httpCalls(result)
				.filter((c) => c.includes("/issues/"))
				.sort(),
		).toEqual([
			`GET /repos/${repo.owner}/${repo.name}/issues/3`,
			`GET /repos/${repo.owner}/${repo.name}/issues/99`,
		]);
		expect(await expectOk<unknown>(await fgj(cwd, "card", "2"))).toEqual({
			number: 2,
			project: "Alpha board",
			column: "To Do",
			as: "t",
		});
		await expectError(await fgj(cwd, "card", "99"), "not_found", 4);
	});

	test("a profile with no web login, and the env tokens, fail with auth before any request", async () => {
		const dir = await makeWorkDir(server, repo);
		await webProfile(server, dir, { web: false });
		const none = await fgj(dir, "list", "--project", "1");
		const err = await expectError(none, "auth", 3);
		expect(err.hint).toBe("fgj auth web --profile t");
		expect(httpCalls(none)).toEqual([]);
		const bare = await makeWorkDir(server, repo);
		const env = await runFgj(server, ["read", "board", "list"], bare);
		const e2 = await expectError(env, "auth", 3);
		expect(e2.hint).toBe("fgj auth status");
		expect(httpCalls(env)).toEqual([]);
	});

	test("an expired stored date fails with auth and sends nothing", async () => {
		const dir = await makeWorkDir(server, repo);
		await webProfile(server, dir);
		const file = join(dir, ".config", "fgj", "hosts.json");
		const store = JSON.parse(readFileSync(file, "utf8"));
		store.profiles.t.web.expires = "2020-01-01T00:00:00.000Z";
		await Bun.write(file, JSON.stringify(store));
		const result = await fgj(dir, "list");
		const err = await expectError(result, "auth", 3);
		expect(err.message).toContain("expired on 2020-01-01");
		expect(err.hint).toBe("fgj auth web --profile t");
		expect(httpCalls(result)).toEqual([]);
	});

	test("a password change revokes the web login: auth error with the sign-in hint", async () => {
		const carol = await createUser(server);
		const tokens = {
			read: await mintToken(server, carol, READ),
			write: await mintToken(server, carol, WRITE),
		};
		const dir = await makeWorkDir(server, repo);
		await webProfile(server, dir, { login: carol, tokens });
		const res = await fetch(
			`${server.url}/api/v1/admin/users/${carol.username}`,
			{
				method: "PATCH",
				headers: {
					authorization: `Basic ${btoa(`${server.username}:${server.password}`)}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					login_name: carol.username,
					source_id: 0,
					password: `pw-${crypto.randomUUID()}`,
				}),
			},
		);
		expect(res.status).toBe(200);
		const result = await fgj(dir, "list", "--project", String(alpha.number));
		const err = await expectError(result, "auth", 3);
		expect(err.hint).toBe("fgj auth web --profile t");
		expect(httpCalls(result)).toEqual(["GET /user/login"]);
	});

	test("parallel calls with one profile all succeed; no call signs another out", async () => {
		const runs = await Promise.all(
			Array.from({ length: 8 }, () =>
				fgj(cwd, "list", "--project", String(alpha.number)),
			),
		);
		for (const r of runs) {
			await expectOk(r);
			// A call that another call signed out would renew twice.
			expect(httpCalls(r).filter((c) => c === "GET /user/login")).toHaveLength(
				1,
			);
		}
	});

	test("board card leaves the caller's notifications unread: a read verb changes nothing", async () => {
		const dave = await createUser(server);
		const n = await createIssue(server, repo, "Watched");
		await addToProject(server, repo, alpha.number, [n]);
		await addComment(server, repo, n, "A reply that notifies the author", dave);
		// Only this repository's notifications, on every page: other test files
		// run at the same time and notify the same admin.
		const unread = async () => {
			const url = `${server.url}/api/v1/repos/${repo.owner}/${repo.name}/issues/${n}`;
			for (let page = 1; ; page++) {
				const list = await adminApi<{ subject: { url: string } }[]>(
					server,
					`/repos/${repo.owner}/${repo.name}/notifications?status-types=unread&page=${page}`,
				);
				if (list.some((x) => x.subject.url === url)) return true;
				if (list.length < server.apiPage) return false;
			}
		};
		for (let i = 0; i < 40 && !(await unread()); i++) await Bun.sleep(250);
		expect(await unread()).toBe(true);
		await expectOk(await fgj(cwd, "card", String(n)));
		expect(await unread()).toBe(true);
	}, 30_000);

	test("a renamed repository fails with the new path, never a silent project null", async () => {
		const old = await createRepo(server);
		await createIssue(server, old, "Moves");
		const p = await createProject(server, old, "Moving board");
		await addToProject(server, old, p.number, [1]);
		const dir = await makeWorkDir(server, old);
		await webProfile(server, dir);
		const res = await fetch(
			`${server.url}/api/v1/repos/${old.owner}/${old.name}`,
			{
				method: "PATCH",
				headers: {
					authorization: `Basic ${btoa(`${server.username}:${server.password}`)}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ name: `${old.name}-new` }),
			},
		);
		expect(res.status).toBe(200);
		const card = await fgj(dir, "card", "1");
		expect(card.code).not.toBe(0);
		expect(card.stderr).toContain(`${old.name}-new`);
		const list = await fgj(dir, "list");
		expect(list.code).not.toBe(0);
		expect(list.stderr).toContain(`${old.name}-new`);
	}, 30_000);

	/** Sends one admin API request with any method, for fixtures. */
	const adminSend = async (method: string, path: string, body: unknown) => {
		const res = await fetch(`${server.url}/api/v1${path}`, {
			method,
			headers: {
				authorization: `Basic ${btoa(`${server.username}:${server.password}`)}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
	};

	test("a read-only collaborator reads the board: the list page shows it no counts", async () => {
		const solo = await createRepo(server);
		await createIssue(server, solo, "Only");
		const only = await createProject(server, solo, "Read only");
		await addToProject(server, solo, only.number, [1]);
		const erin = await createUser(server);
		await adminSend(
			"PUT",
			`/repos/${solo.owner}/${solo.name}/collaborators/${erin.username}`,
			{ permission: "read" },
		);
		const dir = await makeWorkDir(server, solo);
		await webProfile(server, dir, {
			login: erin,
			tokens: {
				read: await mintToken(server, erin, READ),
				write: await mintToken(server, erin, WRITE),
			},
		});
		const out = await expectOk<BoardOut>(await fgj(dir, "list"));
		expect(out.columns[0]).toEqual({ name: "Backlog", issues: [1] });
		expect(await expectOk<unknown>(await fgj(dir, "card", "1"))).toMatchObject({
			project: "Read only",
			column: "Backlog",
		});
	}, 30_000);

	test("more than one page of projects: fgj pages the list", async () => {
		const many = await createRepo(server);
		for (let i = 1; i <= 21; i++) await createProject(server, many, `P${i}`);
		const dir = await makeWorkDir(server, many);
		await webProfile(server, dir);
		const err = await expectError(await fgj(dir, "list"), "usage", 2);
		expect(err.message).toContain("21 open projects");
		expect(err.message).toContain("and 1 more");
		// P1 is on the last page of the default newest-first order.
		const p1 = await expectOk<BoardOut>(
			await fgj(dir, "list", "--project", "P1"),
		);
		expect(p1.project).toBe("P1");
	}, 60_000);

	test("board card names an owner-level project, and the column on it", async () => {
		const own = await createRepo(server);
		await createIssue(server, own, "Owner board");
		const { id, title } = await createOwnerProject(server, "Owner plan");
		try {
			await addToProject(server, own, id, [1]);
			const dir = await makeWorkDir(server, own);
			await webProfile(server, dir);
			expect(await expectOk<unknown>(await fgj(dir, "card", "1"))).toEqual({
				number: 1,
				project: title,
				column: "Backlog",
				as: "t",
			});
		} finally {
			await deleteOwnerProject(server, id);
		}
	});

	test("with the Projects unit off, both verbs fail with not_found and say so", async () => {
		const off = await createRepo(server);
		await createIssue(server, off, "Off");
		const p = await createProject(server, off, "Soon off");
		await addToProject(server, off, p.number, [1]);
		await adminSend("PATCH", `/repos/${off.owner}/${off.name}`, {
			has_projects: false,
		});
		const dir = await makeWorkDir(server, off);
		await webProfile(server, dir);
		for (const argv of [["list"], ["card", "1"]]) {
			const err = await expectError(await fgj(dir, ...argv), "not_found", 4);
			expect(err.message).toContain("Projects unit is off");
		}
	}, 30_000);

	test("a pull request with a large inline review still shows its project", async () => {
		const { repo: pr, number } = await createPull(server, "Reviewed");
		const head = await adminApi<{ head: { ref: string } }>(
			server,
			`/repos/${pr.owner}/${pr.name}/pulls/${number}`,
		);
		// The API timeline hides inline comments, so 160 of them read as empty pages.
		await adminApi(
			server,
			`/repos/${pr.owner}/${pr.name}/pulls/${number}/reviews`,
			{
				event: "COMMENT",
				body: "Review",
				comments: Array.from({ length: 160 }, (_, i) => ({
					path: `${head.head.ref}.txt`,
					new_position: 1,
					body: `inline ${i}`,
				})),
			},
		);
		const p = await createProject(server, pr, "PR board");
		await addToProject(server, pr, p.number, [number]);
		const dir = await makeWorkDir(server, pr);
		await webProfile(server, dir);
		expect(
			await expectOk<unknown>(await fgj(dir, "card", String(number))),
		).toMatchObject({ project: "PR board", column: "Backlog" });
	}, 60_000);

	test("on an owner board, a card with the same number from another repository does not count", async () => {
		const [a, b] = [await createRepo(server), await createRepo(server)];
		await createIssue(server, a, "A1");
		await createIssue(server, b, "B1");
		const { id, title } = await createOwnerProject(server, "Shared");
		try {
			const board = await adminWeb(
				server,
				`/${server.username}/-/projects/${id}`,
			);
			const columns = new Map<string, number>();
			for (const m of board.matchAll(
				/class="project-column[^"]*" data-id="(\d+)"[\s\S]*?project-column-title-label[^>]*>([^<]*)</g,
			)) {
				columns.set((m[2] as string).trim(), Number(m[1]));
			}
			await addToProject(server, a, id, [1]);
			await addToProject(server, b, id, [1]);
			// A's #1 moves to Done; B's #1 stays in Backlog, an earlier column.
			const aIssue = await adminApi<{ id: number }>(
				server,
				`/repos/${a.owner}/${a.name}/issues/1`,
			);
			await adminWeb(
				server,
				`/${server.username}/-/projects/${id}/${columns.get("Done")}/move`,
				{ json: { issues: [{ issueID: aIssue.id, sorting: 0 }] } },
			);
			const dir = await makeWorkDir(server, a);
			await webProfile(server, dir);
			expect(
				await expectOk<unknown>(await fgj(dir, "card", "1")),
			).toMatchObject({
				project: title,
				column: "Done",
			});
		} finally {
			await deleteOwnerProject(server, id);
		}
	});

	test("with the Projects unit off, board card still finds an issue on an owner board", async () => {
		const off = await createRepo(server);
		await createIssue(server, off, "On the owner board");
		const { id, title } = await createOwnerProject(server, "Org plan");
		try {
			await addToProject(server, off, id, [1]);
			await adminSend("PATCH", `/repos/${off.owner}/${off.name}`, {
				has_projects: false,
			});
			const dir = await makeWorkDir(server, off);
			await webProfile(server, dir);
			expect(
				await expectOk<unknown>(await fgj(dir, "card", "1")),
			).toMatchObject({
				project: title,
				column: "Backlog",
			});
			// Issue 2 is on no owner board; a hidden repository board could hold it.
			await createIssue(server, off, "Not on the owner board");
			const err = await expectError(
				await fgj(dir, "card", "2"),
				"not_found",
				4,
			);
			expect(err.message).toContain("Projects unit is off");
			// In a batch, the hidden-boards error fails the call: no item may read as null.
			await expectError(await fgj(dir, "card", "1", "2"), "not_found", 4);
			// A number that does not exist is missing, not an error for the batch.
			expect(
				await expectOk<unknown>(await fgj(dir, "card", "1", "99")),
			).toMatchObject({
				items: [{ number: 1, project: title }],
				missing: [99],
			});
		} finally {
			await deleteOwnerProject(server, id);
		}
	});

	test("no output, trace, or audit line holds the cookie", async () => {
		const file = join(cwd, ".config", "fgj", "hosts.json");
		const value: string = JSON.parse(readFileSync(file, "utf8")).profiles.t.web
			.value;
		expect(value.length).toBeGreaterThan(8);
		const result = await fgj(cwd, "card", "1");
		await expectOk(result);
		const text = result.stdout + result.stderr + result.trace;
		expect(text).not.toContain(value);
		expect(text).not.toContain("persistent=");
	});
});

import { beforeAll, describe, expect, test } from "bun:test";
import {
	adminApi,
	createIssue,
	createLabel,
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

interface Item {
	number: number;
	title?: string;
	state?: string;
	labels?: string[];
	body?: string;
	[key: string]: unknown;
}

interface List {
	items: Item[];
	total: number;
	next: string | null;
	as: string;
}

describe("fgj read issue list", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;
	/** Open issues, newest first. */
	const open: number[] = [];
	let closed: number;
	let onlyA: number;
	let aAndB: number;
	let archivedOne: number;

	/** A pull request, made once: a PR fixture is several writes, too slow for one test. */
	let pull: Awaited<ReturnType<typeof createPull>>;
	let pullDir: string;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		cwd = await makeWorkDir(server, repo);
		const a = await createLabel(server, repo, "area/a");
		const b = await createLabel(server, repo, "area/b");
		const old = await createLabel(server, repo, "old/retired", {
			archived: true,
		});
		onlyA = await createIssue(server, repo, "Only a", {
			labels: [a],
			body: "The quokkaword is here.",
		});
		aAndB = await createIssue(server, repo, "Both", { labels: [a, b] });
		archivedOne = await createIssue(server, repo, "Archived label", {
			labels: [old],
		});
		const made = [onlyA, aAndB, archivedOne];
		// 25 open issues: more than the default window of 20, and several server pages.
		for (let i = 0; i < 22; i++) {
			made.push(await createIssue(server, repo, `Filler ${i}`));
		}
		closed = await createIssue(server, repo, "Closed");
		await fetch(
			`${server.url}/api/v1/repos/${repo.owner}/${repo.name}/issues/${closed}`,
			{
				method: "PATCH",
				headers: {
					authorization: `Basic ${btoa(`${server.username}:${server.password}`)}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ state: "closed" }),
			},
		);
		open.push(...made.reverse());
		pull = await createPull(server);
		await createIssue(server, pull.repo, "An issue next to the PR");
		pullDir = await makeWorkDir(server, pull.repo);
	}, 60_000);

	const list = (dir: string, ...rest: string[]) =>
		runFgj(server, ["read", "issue", "list", ...rest], dir);

	test("lists 20 open issues, newest first, with number, title, state, and labels, a total, and next", async () => {
		const result = await list(cwd);
		const out = await expectOk<List>(result);
		expect(out.items.map((i) => i.number)).toEqual(open.slice(0, 20));
		expect(Object.keys(out.items[0] ?? {}).sort()).toEqual([
			"labels",
			"number",
			"state",
			"title",
		]);
		expect(out.total).toBe(open.length);
		expect(out.next).toBe("fgj read issue list --offset 20");
		expect(onlyGets(result)).toBe(true);
	});

	test("an offset that crosses a server page returns the right issues, and the last page has next null", async () => {
		const from = open.length - 8;
		expect(from).toBeGreaterThan(server.apiPage);
		const out = await expectOk<List>(
			await list(cwd, "--offset", String(from), "--limit", "10"),
		);
		expect(out.items.map((i) => i.number)).toEqual(open.slice(from));
		expect(out.next).toBeNull();
	});

	test("an offset past page 1 reads the server's page size, then the right issues", async () => {
		const from = server.apiPage + 2;
		const out = await expectOk<List>(
			await list(cwd, "--offset", String(from), "--limit", "3"),
		);
		expect(out.items.map((i) => i.number)).toEqual(open.slice(from, from + 3));
		// An offset at or past fgj's first page of 50 reads the real server's page
		// size; past the last issue, the window is empty. The unit tests cover the
		// page math for every page size.
		const far = await list(cwd, "--offset", "50", "--limit", "3");
		expect(httpCalls(far)).toContain("GET /settings/api");
		// Offset 50 at the server's page size is the first item of page 11.
		expect(
			httpCalls(far).some((c) =>
				c.endsWith(`limit=${server.apiPage}&page=${50 / server.apiPage + 1}`),
			),
		).toBe(true);
		expect((await expectOk<List>(far)).items).toEqual([]);
	});

	test("--state closed and --state all", async () => {
		const c = await expectOk<List>(await list(cwd, "--state", "closed"));
		expect(c.items.map((i) => i.number)).toEqual([closed]);
		const all = await expectOk<List>(await list(cwd, "--state", "all"));
		expect(all.total).toBe(open.length + 1);
	});

	test("--label matches issues that have every named label, without case, archived labels too", async () => {
		const a = await expectOk<List>(await list(cwd, "--label", "Area/A"));
		expect(a.items.map((i) => i.number)).toEqual([aAndB, onlyA]);
		expect(a.items[0]?.labels).toEqual(["area/a", "area/b"]);
		const both = await expectOk<List>(
			await list(cwd, "--label", "area/a,area/b"),
		);
		expect(both.items.map((i) => i.number)).toEqual([aAndB]);
		const old = await expectOk<List>(await list(cwd, "--label", "old/retired"));
		expect(old.items.map((i) => i.number)).toEqual([archivedOne]);
	});

	test("an unknown --label fails with usage before the issue request, and names close labels", async () => {
		const result = await list(cwd, "--label", "area/c");
		const err = await expectError(result, "usage", 2);
		expect(err.message).toContain("area/a");
		expect(err.hint).toBe("fgj read label list");
		expect(httpCalls(result)).toEqual([
			`GET /repos/${repo.owner}/${repo.name}/labels?limit=50&page=1`,
		]);
	});

	test("--search finds a word in the body, and combines with --label", async () => {
		// The server indexes new issues a moment after they are made.
		let out: List | undefined;
		for (let i = 0; i < 20; i++) {
			out = await expectOk<List>(await list(cwd, "--search", "quokkaword"));
			if (out.total > 0) break;
			await Bun.sleep(500);
		}
		expect(out?.items.map((i) => i.number)).toEqual([onlyA]);
		const none = await expectOk<List>(
			await list(cwd, "--search", "quokkaword", "--label", "area/b"),
		);
		expect(none.items).toEqual([]);
		expect(none.total).toBe(0);
	});

	test("pull requests never appear", async () => {
		const out = await expectOk<List>(await list(pullDir, "--state", "all"));
		expect(out.items.map((i) => i.title)).toEqual(["An issue next to the PR"]);
	});

	test("--fields adds the body, and link fields are not list fields", async () => {
		const out = await expectOk<List>(
			await list(cwd, "--label", "area/b", "--fields", "number,body"),
		);
		expect(out.items).toEqual([{ number: aAndB, body: "" }]);
		await expectError(
			await list(cwd, "--fields", "number,depends_on"),
			"usage",
			2,
		);
	});

	test("a page over the output cap stops early, and next starts at the first issue left out", async () => {
		const big = await createRepo(server);
		for (let i = 0; i < 10; i++) {
			await adminApi(server, `/repos/${big.owner}/${big.name}/issues`, {
				title: `Big ${i}`,
				body: "b".repeat(4000),
			});
		}
		const out = await expectOk<List>(
			await list(await makeWorkDir(server, big), "--fields", "number,body"),
		);
		expect(out.items.length).toBeLessThan(10);
		expect(out.next).toBe(
			`fgj read issue list --fields number,body --offset ${out.items.length}`,
		);
	});

	test("bad flag values fail with usage before any request", async () => {
		for (const argv of [
			["--state", "done"],
			["--search", ""],
			["--limit", "0"],
		]) {
			const result = await list(cwd, ...argv);
			await expectError(result, "usage", 2);
			expect(httpCalls(result)).toEqual([]);
		}
	});
});

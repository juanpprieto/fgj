import { beforeAll, describe, expect, test } from "bun:test";
import {
	addDependency,
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

interface Issue {
	number: number;
	title?: string;
	state?: string;
	labels?: string[];
	body?: string;
	body_truncated?: true;
	body_chars?: number;
	pr?: true;
	depends_on?: (number | string)[];
	blocks?: (number | string)[];
	[key: string]: unknown;
}

interface Many {
	items: Issue[];
	missing?: number[];
	next?: string;
	hint?: string;
	as: string;
}

describe("fgj read issue get", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;
	/** A pull request, made once: a PR fixture is several writes, too slow for one test. */
	let pull: Awaited<ReturnType<typeof createPull>>;
	let pullDir: string;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		cwd = await makeWorkDir(server, repo);
		pull = await createPull(server);
		pullDir = await makeWorkDir(server, pull.repo);
	}, 60_000);

	const get = (dir: string, ...rest: string[]) =>
		runFgj(server, ["read", "issue", "get", ...rest], dir);

	test("one issue returns the issue itself: number, title, state, label names, and body, in one GET", async () => {
		const bug = await createLabel(server, repo, "type/bug");
		const n = await createIssue(server, repo, "Crash on start", {
			body: "Steps to reproduce.",
			labels: [bug],
		});
		const result = await get(cwd, String(n));
		expect(await expectOk<Issue>(result)).toEqual({
			number: n,
			title: "Crash on start",
			state: "open",
			labels: ["type/bug"],
			body: "Steps to reproduce.",
			as: "env",
		});
		expect(httpCalls(result)).toEqual([
			`GET /repos/${repo.owner}/${repo.name}/issues/${n}`,
		]);
	});

	test("many issues return items in the order given, and missing names the numbers that do not exist", async () => {
		const a = await createIssue(server, repo, "First");
		const b = await createIssue(server, repo, "Second");
		const out = await expectOk<Many>(
			await get(cwd, String(b), "999999", `#${a}`),
		);
		expect(out.items.map((i) => i.number)).toEqual([b, a]);
		expect(out.missing).toEqual([999999]);
		const all = await expectOk<Many>(await get(cwd, String(a), String(b)));
		expect(all.items).toHaveLength(2);
		expect("missing" in all).toBe(false);
	});

	test("a repeated number returns its issue once", async () => {
		const a = await createIssue(server, repo, "Once");
		const out = await expectOk<Many>(await get(cwd, String(a), String(a)));
		expect(out.items.map((i) => i.number)).toEqual([a]);
	});

	test("one missing issue fails with not_found", async () => {
		const err = await expectError(await get(cwd, "999999"), "not_found", 4);
		expect(err.hint).toBe("fgj help issue get");
	});

	test("issues in a repository that does not exist fail with not_found, not as missing", async () => {
		const result = await get(
			cwd,
			"1",
			"2",
			"--repo",
			`${repo.owner}/nope-${Date.now()}`,
		);
		const err = await expectError(result, "not_found", 4);
		expect(err.message).toContain("repository");
	});

	test("depends_on and blocks return issue numbers, and owner/name#n for another repository", async () => {
		const other = await createRepo(server);
		const main = await createIssue(server, repo, "Main");
		const before = await createIssue(server, repo, "Before");
		const elsewhere = await createIssue(server, other, "Elsewhere");
		const after = await createIssue(server, repo, "After");
		await addDependency(server, repo, main, { number: before });
		await addDependency(server, repo, main, { number: elsewhere, repo: other });
		await addDependency(server, repo, after, { number: main });
		const out = await expectOk<Issue>(
			await get(cwd, String(main), "--fields", "number,depends_on,blocks"),
		);
		expect(out.number).toBe(main);
		expect(new Set(out.depends_on)).toEqual(
			new Set([before, `${other.owner}/${other.name}#${elsewhere}`]),
		);
		expect(out.blocks).toEqual([after]);
	});

	test("depends_on reads every page past the server's page limit", async () => {
		const main = await createIssue(server, repo, "Many dependencies");
		const deps: number[] = [];
		// Two full server pages and one more: fgj must read three pages.
		for (let i = 0; i < server.apiPage * 2 + 1; i++) {
			const n = await createIssue(server, repo, `Dependency ${i}`);
			await addDependency(server, repo, main, { number: n });
			deps.push(n);
		}
		const out = await expectOk<Issue>(
			await get(cwd, String(main), "--fields", "depends_on"),
		);
		expect(new Set(out.depends_on)).toEqual(new Set(deps));
	}, 60_000);

	test("a pull request number returns the item with pr:true, and an issue has no pr key", async () => {
		const pr = await expectOk<Issue>(await get(pullDir, String(pull.number)));
		expect(pr).toMatchObject({ number: pull.number, pr: true });
		const n = await createIssue(server, repo, "Plain issue");
		expect("pr" in (await expectOk<Issue>(await get(cwd, String(n))))).toBe(
			false,
		);
	});

	test("a body longer than --body-max is cut, with its length and a hint that shows it whole", async () => {
		const n = await createIssue(server, repo, "Long", {
			body: "z".repeat(5000),
		});
		const out = await expectOk<Issue & { hint?: string }>(
			await get(cwd, String(n)),
		);
		expect(out.body_truncated).toBe(true);
		expect(out.body_chars).toBe(5000);
		expect(Array.from(out.body ?? "")).toHaveLength(4000);
		expect(out.hint).toBe(`fgj read issue get ${n} --body-max 20000`);
	});

	test("--fields picks fields, and --fields alone lists them", async () => {
		const n = await createIssue(server, repo, "Fields");
		const out = await expectOk<Issue>(
			await get(cwd, String(n), "--fields", "number,author,url,comments"),
		);
		expect(Object.keys(out).sort()).toEqual([
			"as",
			"author",
			"comments",
			"number",
			"url",
		]);
		expect(out.author).toBe(server.username);
		expect(String(out.url)).toEndWith(`/issues/${n}`);
		const fields = await expectOk<{ fields: string[]; default: string[] }>(
			await get(cwd, String(n), "--fields"),
		);
		expect(fields.default).toEqual([
			"number",
			"title",
			"state",
			"labels",
			"body",
		]);
		expect(fields.fields).toContain("depends_on");
	});

	test("issue URLs name the repository with no git origin, and URLs of two repositories fail with usage", async () => {
		const n = await createIssue(server, repo, "By URL");
		const url = `${server.url}/${repo.owner}/${repo.name}/issues/${n}`;
		const noGit = await makeWorkDir(server);
		expect(await expectOk<Issue>(await get(noGit, url))).toMatchObject({
			number: n,
		});
		const other = await createRepo(server);
		const otherUrl = `${server.url}/${other.owner}/${other.name}/issues/1`;
		const result = await get(noGit, url, otherUrl);
		await expectError(result, "usage", 2);
		expect(httpCalls(result)).toEqual([]);
	});

	test("a result over the output cap stops early, and next reads the rest", async () => {
		const numbers: number[] = [];
		for (let i = 0; i < 8; i++) {
			numbers.push(
				await createIssue(server, repo, `Big ${i}`, { body: "b".repeat(4000) }),
			);
		}
		const out = await expectOk<Many>(await get(cwd, ...numbers.map(String)));
		expect(out.items.length).toBeLessThan(8);
		const rest = numbers.slice(out.items.length);
		expect(out.next).toBe(`fgj read issue get ${rest.join(" ")}`);
	});

	test("more than 50 issues in one call fail with usage, before any request", async () => {
		const many = Array.from({ length: 51 }, (_, i) => String(i + 1));
		const result = await get(cwd, ...many);
		await expectError(result, "usage", 2);
		expect(httpCalls(result)).toEqual([]);
	});

	test("it sends only GET requests", async () => {
		const n = await createIssue(server, repo, "Read only");
		const result = await get(cwd, String(n), "--fields", "depends_on,blocks");
		await expectOk(result);
		expect(onlyGets(result)).toBe(true);
	});

	test("a number next to an issue URL fails with usage before any request", async () => {
		const n = await createIssue(server, repo, "Mixed");
		const url = `${server.url}/${repo.owner}/${repo.name}/issues/${n}`;
		const result = await get(cwd, "1", url);
		await expectError(result, "usage", 2);
		expect(httpCalls(result)).toEqual([]);
	});
});

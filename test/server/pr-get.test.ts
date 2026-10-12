import { beforeAll, describe, expect, test } from "bun:test";
import {
	addPull,
	adminApi,
	createIssue,
	createPull,
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

interface Pr {
	number: number;
	title?: string;
	state?: string;
	draft?: boolean;
	mergeable?: boolean;
	base?: string;
	head?: string;
	head_sha?: string;
	url?: string;
	body?: string;
	merge_commit?: string;
	[key: string]: unknown;
}

interface Many {
	items: Pr[];
	missing?: number[];
	as: string;
}

describe("fgj read pr get", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let first: number;
	let cwd: string;

	beforeAll(async () => {
		server = await loadServer();
		const made = await createPull(server, "Add the login page");
		repo = made.repo;
		first = made.number;
		cwd = await makeWorkDir(server, repo);
	}, 60_000);

	const get = (dir: string, ...rest: string[]) =>
		runFgj(server, ["read", "pr", "get", ...rest], dir);

	const raw = (n: number) =>
		adminApi<{ head: { ref: string; sha: string } }>(
			server,
			`/repos/${repo.owner}/${repo.name}/pulls/${n}`,
		);

	test("one PR returns names, not objects, with the default fields, in one GET", async () => {
		const n = await addPull(server, repo, "Fix the header", "Why and how.");
		const pull = await raw(n);
		const result = await get(cwd, String(n));
		expect(await expectOk<Pr>(result)).toEqual({
			number: n,
			title: "Fix the header",
			state: "open",
			draft: false,
			mergeable: true,
			base: "main",
			head: pull.head.ref,
			head_sha: pull.head.sha,
			url: `${server.url}/${repo.owner}/${repo.name}/pulls/${n}`,
			body: "Why and how.",
			as: "env",
		});
		expect(httpCalls(result)).toEqual([
			`GET /repos/${repo.owner}/${repo.name}/pulls/${n}`,
		]);
		expect(onlyGets(result)).toBe(true);
	});

	test("a WIP title reads as a draft", async () => {
		const n = await addPull(server, repo, "WIP: not ready");
		expect(await expectOk<Pr>(await get(cwd, String(n)))).toMatchObject({
			number: n,
			draft: true,
		});
	});

	test("a merged PR has state merged and its merge commit", async () => {
		const n = await addPull(server, repo, "Merge me");
		await adminApi(
			server,
			`/repos/${repo.owner}/${repo.name}/pulls/${n}/merge`,
			{
				Do: "merge",
			},
		);
		const out = await expectOk<Pr>(await get(cwd, String(n)));
		expect(out.state).toBe("merged");
		expect(out.merge_commit).toMatch(/^[0-9a-f]{40}$/);
		expect("merged" in out).toBe(false);
		// Forgejo still says mergeable on a merged PR; fgj shows it only while open.
		expect("mergeable" in out).toBe(false);
	});

	test("many PRs return items in the order given, with missing numbers", async () => {
		const n = await addPull(server, repo, "Second");
		const out = await expectOk<Many>(
			await get(cwd, String(n), "999999", String(first)),
		);
		expect(out.items.map((p) => p.number)).toEqual([n, first]);
		expect(out.missing).toEqual([999999]);
	});

	test("an issue number fails with not_found and points to issue get", async () => {
		const issue = await createIssue(server, repo, "An issue, not a PR");
		const err = await expectError(
			await get(cwd, String(issue)),
			"not_found",
			4,
		);
		expect(err.message).toContain("not a pull request");
		expect(err.hint).toBe(`fgj read issue get ${issue}`);
	});

	test("--fields picks opt-in fields, and --fields alone lists them", async () => {
		const out = await expectOk<Pr>(
			await get(
				cwd,
				String(first),
				"--fields",
				"number,author,base_sha,comments",
			),
		);
		expect(Object.keys(out).sort()).toEqual([
			"as",
			"author",
			"base_sha",
			"comments",
			"number",
		]);
		expect(out.author).toBe(server.username);
		expect(String(out.base_sha)).toMatch(/^[0-9a-f]{40}$/);
		const fields = await expectOk<{ default: string[] }>(
			await get(cwd, String(first), "--fields"),
		);
		expect(fields.default).toEqual([
			"number",
			"title",
			"state",
			"draft",
			"mergeable",
			"base",
			"head",
			"head_sha",
			"url",
			"body",
			"merge_commit",
		]);
	});

	test("a PR URL names the repository with no git origin", async () => {
		const url = `${server.url}/${repo.owner}/${repo.name}/pulls/${first}`;
		expect(
			await expectOk<Pr>(await get(await makeWorkDir(server), url)),
		).toMatchObject({ number: first, state: "open" });
	});

	test("a body longer than --body-max is cut, with a hint that shows it whole", async () => {
		const n = await addPull(server, repo, "Long body", "x".repeat(5000));
		const out = await expectOk<Pr & { hint?: string }>(
			await get(cwd, String(n)),
		);
		expect(out.body_truncated).toBe(true);
		expect(out.body_chars).toBe(5000);
		expect(out.hint).toBe(`fgj read pr get ${n} --body-max 20000`);
	});

	test("a closed PR has state closed, no merge commit, and no mergeable", async () => {
		const n = await addPull(server, repo, "Close me");
		await fetch(
			`${server.url}/api/v1/repos/${repo.owner}/${repo.name}/pulls/${n}`,
			{
				method: "PATCH",
				headers: {
					authorization: `Basic ${btoa(`${server.username}:${server.password}`)}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ state: "closed" }),
			},
		);
		const out = await expectOk<Pr>(await get(cwd, String(n)));
		expect(out.state).toBe("closed");
		expect("merge_commit" in out).toBe(false);
		expect("mergeable" in out).toBe(false);
	});

	test("an issue number costs one more GET on a miss, and a missing number says it does not exist", async () => {
		const issue = await createIssue(server, repo, "Only an issue");
		const result = await get(cwd, String(issue));
		await expectError(result, "not_found", 4);
		expect(httpCalls(result)).toEqual([
			`GET /repos/${repo.owner}/${repo.name}/pulls/${issue}`,
			`GET /repos/${repo.owner}/${repo.name}/issues/${issue}`,
		]);
		const err = await expectError(await get(cwd, "999999"), "not_found", 4);
		expect(err.message).toContain("does not exist");
	});

	test("an issue number among many PRs is listed as missing", async () => {
		const issue = await createIssue(server, repo, "Issue among PRs");
		const out = await expectOk<Many>(
			await get(cwd, String(first), String(issue)),
		);
		expect(out.items.map((p) => p.number)).toEqual([first]);
		expect(out.missing).toEqual([issue]);
	});

	test("a repository that does not exist fails with not_found", async () => {
		const err = await expectError(
			await get(cwd, "1", "--repo", `${repo.owner}/nope-${Date.now()}`),
			"not_found",
			4,
		);
		expect(err.message).toContain("repository");
	});

	test("usage errors name pull requests, and a PR URL stays a PR URL in hints", async () => {
		const err = await expectError(await get(cwd, "abc"), "usage", 2);
		expect(err.message).toContain("pull request");
		expect(err.message).not.toContain("issue");
		const n = await addPull(server, repo, "Long via URL", "y".repeat(5000));
		const url = `${server.url}/${repo.owner}/${repo.name}/pulls/${n}`;
		const out = await expectOk<Pr & { hint?: string }>(
			await get(await makeWorkDir(server), url),
		);
		expect(out.hint).toBe(`fgj read pr get ${url} --body-max 20000`);
	});
});

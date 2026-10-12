import { beforeAll, describe, expect, test } from "bun:test";
import {
	adminApi,
	createIssue,
	expectError,
	expectOk,
	type FixtureRepo,
	httpCalls,
	loadServer,
	makeWorkDir,
	onlyGets,
	pushBranch,
	runFgj,
	type TestServer,
} from "../support/forgejo.ts";

/** A result object, for exact comparisons. */
type Json = Record<string, unknown>;

describe("fgj read status get", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await loadServer();
	});

	/** A repository with a `main` branch, and a work dir with it as origin. */
	const setup = async () => {
		const name = `t-${crypto.randomUUID().slice(0, 8)}`;
		await adminApi(server, "/user/repos", { name, auto_init: true });
		const repo: FixtureRepo = { owner: server.username, name };
		return { repo, cwd: await makeWorkDir(server, repo) };
	};

	const post = (
		repo: FixtureRepo,
		sha: string,
		status: Record<string, string>,
	) =>
		adminApi(
			server,
			`/repos/${repo.owner}/${repo.name}/statuses/${sha}`,
			status,
		);

	const status = (cwd: string, ...argv: string[]) =>
		runFgj(server, ["read", "status", "get", ...argv], cwd);

	test("a commit with no checks reads as none, not as a pass, with GET only", async () => {
		const { repo, cwd } = await setup();
		const branch = "feat/no-checks";
		const sha = await pushBranch(server, repo, branch);
		const result = await status(cwd, branch);
		expect(await expectOk<Json>(result)).toEqual({
			sha,
			state: "none",
			total: 0,
			checks: [],
			note: "No check reported for this commit. none is not a pass: no check ran, or none has started yet.",
			as: "env",
		});
		expect(onlyGets(result)).toBe(true);
		const base = `/repos/${repo.owner}/${repo.name}`;
		expect(httpCalls(result)).toEqual([
			`GET ${base}/commits?sha=${encodeURIComponent(branch)}&limit=1&page=1&stat=false&verification=false&files=false`,
			`GET ${base}/commits/${sha}/status?page=1&limit=50`,
		]);
	}, 20_000);

	test("a SHA, a short SHA, a branch with /, and a tag name the same commit; a bad ref is not_found", async () => {
		const { repo, cwd } = await setup();
		const sha = await pushBranch(server, repo, "feat/a/b");
		await adminApi(server, `/repos/${repo.owner}/${repo.name}/tags`, {
			tag_name: "v1",
			target: sha,
		});
		for (const ref of [sha, sha.slice(0, 8), "feat/a/b", "v1"]) {
			expect((await expectOk<Json>(await status(cwd, ref))).sha).toBe(sha);
		}
		for (const ref of ["nope", "0000000"]) {
			const err = await expectError(await status(cwd, ref), "not_found", 4);
			expect(err.message).toContain(`No commit, branch, or tag "${ref}"`);
		}
	}, 20_000);

	test("checks link to their Actions run, a failure wins, and the hint reads the failed run", async () => {
		const { repo, cwd } = await setup();
		const sha = await pushBranch(server, repo, "feat/fail");
		await post(repo, sha, {
			state: "success",
			context: "ext/scan",
			target_url: "https://ci.example.invalid/build/9",
		});
		await post(repo, sha, {
			state: "failure",
			context: "Verify / verify (push)",
			description: "Has failed",
			target_url: `/${repo.owner}/${repo.name}/actions/runs/7/jobs/0`,
		});
		const out = await expectOk<Json>(await status(cwd, sha));
		expect(out).toEqual({
			sha,
			state: "failure",
			total: 2,
			checks: expect.arrayContaining([
				{
					context: "Verify / verify (push)",
					state: "failure",
					description: "Has failed",
					run: 7,
				},
				{
					context: "ext/scan",
					state: "success",
					url: "https://ci.example.invalid/build/9",
				},
			]),
			hint: "fgj read run get 7",
			as: "env",
		});
	}, 20_000);

	test("Forgejo's rule: error gives failure, and warning beats pending", async () => {
		const { repo, cwd } = await setup();
		const cases: [string[], string][] = [
			[["error", "success"], "failure"],
			[["warning", "pending"], "warning"],
			[["pending", "success"], "pending"],
			[["skipped", "success"], "success"],
			[["skipped"], "skipped"],
		];
		for (const [states, expected] of cases) {
			const sha = await pushBranch(server, repo, `s-${states.join("-")}`);
			for (const [i, state] of states.entries()) {
				await post(repo, sha, { state, context: `c${i}` });
			}
			const out = await expectOk<Json>(await status(cwd, sha));
			expect({ states, state: out.state }).toEqual({
				states,
				state: expected,
			});
		}
	}, 30_000);

	test("more checks than one server page: fgj reads every page", async () => {
		const { repo, cwd } = await setup();
		const sha = await pushBranch(server, repo, "feat/many");
		// Two full server pages of successes; the failure sits alone on page 3.
		for (let i = 0; i < server.apiPage * 2; i++) {
			await post(repo, sha, { state: "success", context: `ok/${i}` });
		}
		await post(repo, sha, { state: "failure", context: "zz/last" });
		const result = await status(cwd, sha);
		const out = await expectOk<Json>(result);
		expect(out.total).toBe(server.apiPage * 2 + 1);
		expect(out.state).toBe("failure");
		expect(
			httpCalls(result).filter((c) => c.includes("/status?")),
		).toHaveLength(3);
	}, 20_000);

	test("--pr reads the head and the base's required checks; a missing required check keeps the state pending", async () => {
		const { repo, cwd } = await setup();
		const base = `/repos/${repo.owner}/${repo.name}`;
		const sha = await pushBranch(server, repo, "feat/pr");
		const pr = await adminApi<{ number: number }>(server, `${base}/pulls`, {
			head: "feat/pr",
			base: "main",
			title: "Checks",
		});
		await adminApi(server, `${base}/branch_protections`, {
			rule_name: "main",
			enable_status_check: true,
			status_check_contexts: ["ci/*", "Verify / verify (pull_request)"],
		});
		await post(repo, sha, { state: "success", context: "ci/lint" });
		const result = await status(cwd, "--pr", String(pr.number));
		expect(await expectOk<Json>(result)).toEqual({
			sha,
			state: "pending",
			total: 1,
			checks: [{ context: "ci/lint", state: "success" }],
			required: ["ci/*", "Verify / verify (pull_request)"],
			missing: ["Verify / verify (pull_request)"],
			hint: `fgj read status get --pr ${pr.number}`,
			as: "env",
		});
		expect(httpCalls(result)).toEqual([
			`GET ${base}/pulls/${pr.number}`,
			`GET ${base}/branches/main`,
			`GET ${base}/commits/${sha}/status?page=1&limit=50`,
		]);
		await post(repo, sha, {
			state: "success",
			context: "Verify / verify (pull_request)",
		});
		expect(
			await expectOk<Json>(await status(cwd, "--pr", String(pr.number))),
		).toMatchObject({ state: "success", missing: [] });
	}, 30_000);

	test("usage and not_found: no ref, two refs, a ref and --pr, a bad ref, and an issue number", async () => {
		const { repo, cwd } = await setup();
		for (const argv of [[], ["a", "b"], ["main", "--pr", "1"], ["main..x"]]) {
			const result = await status(cwd, ...argv);
			await expectError(result, "usage", 2);
			expect(httpCalls(result)).toEqual([]);
		}
		const issue = await createIssue(server, repo, "Not a PR");
		const err = await expectError(
			await status(cwd, "--pr", String(issue)),
			"not_found",
			4,
		);
		expect(err.message).toContain(`No pull request ${issue}`);
	});
});

import { beforeAll, describe, expect, test } from "bun:test";
import {
	adminApi,
	expectError,
	expectOk,
	type FixtureRepo,
	type FixtureRun,
	httpCalls,
	loadServer,
	makeWorkDir,
	onlyGets,
	pushBranch,
	pushWorkflow,
	runFgj,
	type TestServer,
	waitForRuns,
} from "../support/forgejo.ts";

/** A result object, for exact comparisons. */
type Json = Record<string, unknown>;

/** Short times for tests: a 2 s cap, 0.25 s polls, and a 1 s grace for no checks. */
const TIMES = { FGJ_WAIT_TIMES: "2000,250,1000" };

/**
 * Times for a wait that the grace must end: a cap of 3 times the grace leaves
 * room for reads of up to about 0.7 s under parallel load, so the cap does not
 * end it first.
 */
const GRACE_TIMES = { FGJ_WAIT_TIMES: "3000,250,1000" };

/**
 * True when fgj sent one request twice, so it polled. "At once" is proved by
 * the requests, not by the clock: other test files run at the same time.
 */
const polled = (result: Parameters<typeof httpCalls>[0]) => {
	const calls = httpCalls(result);
	return new Set(calls).size !== calls.length;
};

describe("fgj read status wait", () => {
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

	/** Runs the wait and measures how long the call took. */
	const wait = async (cwd: string, ...argv: string[]) => {
		const start = Date.now();
		const result = await runFgj(
			server,
			["read", "status", "wait", ...argv],
			cwd,
			TIMES,
		);
		return { result, ms: Date.now() - start };
	};

	/** Runs a wait that the grace ends, with room for slow reads. */
	const graceWait = async (cwd: string, ...argv: string[]) => {
		const start = Date.now();
		const result = await runFgj(
			server,
			["read", "status", "wait", ...argv],
			cwd,
			GRACE_TIMES,
		);
		return { result, ms: Date.now() - start };
	};

	test("a commit with no checks ends as none after the grace, not after the cap, with GET only", async () => {
		const { repo, cwd } = await setup();
		const sha = await pushBranch(server, repo, "feat/none");
		const { result, ms } = await graceWait(cwd, sha);
		expect(await expectOk<Json>(result)).toMatchObject({
			sha,
			state: "none",
			total: 0,
			checks: [],
		});
		// It waited for the grace; none, not pending, shows that the grace ended it.
		expect(ms).toBeGreaterThanOrEqual(1000);
		expect(onlyGets(result)).toBe(true);
	}, 20_000);

	test("a finished commit ends at once with its state", async () => {
		const { repo, cwd } = await setup();
		const sha = await pushBranch(server, repo, "feat/green");
		await post(repo, sha, { state: "success", context: "ci/lint" });
		const { result } = await wait(cwd, sha);
		expect(await expectOk<Json>(result)).toEqual({
			sha,
			state: "success",
			total: 1,
			checks: [{ context: "ci/lint", state: "success" }],
			as: "env",
		});
		expect(polled(result)).toBe(false);
	}, 20_000);

	test("a check that stays pending returns at the cap with next and how long it waited", async () => {
		const { repo, cwd } = await setup();
		const sha = await pushBranch(server, repo, "feat/slow");
		await post(repo, sha, { state: "pending", context: "ci/slow" });
		const { result, ms } = await wait(cwd, sha);
		const out = await expectOk<Json>(result);
		expect(out).toMatchObject({
			sha,
			state: "pending",
			total: 1,
			next: `fgj read status wait ${sha}`,
		});
		expect(typeof out.pending_s).toBe("number");
		// It waited, not answered at once. The pending state proves that the cap
		// ended it; the unit tests prove the budget. No upper clock bound: other
		// test files run at the same time.
		expect(ms).toBeGreaterThanOrEqual(1000);
	}, 20_000);

	test("a warning next to a pending check keeps the wait pending", async () => {
		const { repo, cwd } = await setup();
		const sha = await pushBranch(server, repo, "feat/warn");
		await post(repo, sha, { state: "warning", context: "ext/scan" });
		await post(repo, sha, { state: "pending", context: "ci/slow" });
		const { result } = await wait(cwd, sha);
		// Forgejo combines warning over pending, but a check still runs.
		expect(await expectOk<Json>(result)).toMatchObject({
			state: "pending",
			next: `fgj read status wait ${sha}`,
		});
	}, 20_000);

	test("a check that appears during the grace is waited for, not reported as none", async () => {
		const { repo, cwd } = await setup();
		const sha = await pushBranch(server, repo, "feat/late-check");
		const [{ result }] = await Promise.all([
			wait(cwd, sha),
			Bun.sleep(300).then(() =>
				post(repo, sha, { state: "pending", context: "ci/late" }),
			),
		]);
		expect(await expectOk<Json>(result)).toMatchObject({
			state: "pending",
			next: `fgj read status wait ${sha}`,
		});
	}, 20_000);

	test("a check that finishes during the call ends the wait at once", async () => {
		const { repo, cwd } = await setup();
		const sha = await pushBranch(server, repo, "feat/later");
		await post(repo, sha, { state: "pending", context: "ci/later" });
		const [{ result }] = await Promise.all([
			wait(cwd, sha),
			Bun.sleep(300).then(() =>
				post(repo, sha, { state: "success", context: "ci/later" }),
			),
		]);
		// A final state, not pending at the cap: the check's end ended the wait.
		expect(await expectOk<Json>(result)).toMatchObject({
			state: "success",
		});
	}, 20_000);

	test("the first failure ends the wait, names its run with the failure lines, and counts the checks still pending", async () => {
		const { repo, cwd } = await setup();
		await pushWorkflow(
			server,
			repo,
			"on: [push]\njobs:\n  lint:\n    runs-on: x\n    steps:\n      - run: exit 0\n  verify:\n    runs-on: x\n    steps:\n      - run: exit 1\n",
		);
		const [run] = (await waitForRuns(server, repo, 1)) as [FixtureRun];
		await post(repo, run.sha, { state: "pending", context: "ci/other" });
		await post(repo, run.sha, {
			state: "failure",
			context: "ci/verify",
			// The check links to job 1; the block must be that job's, not job 0's.
			target_url: `/${repo.owner}/${repo.name}/actions/runs/${run.number}/jobs/1`,
		});
		const { result } = await wait(cwd, run.sha);
		const out = await expectOk<Json>(result);
		expect(out).toMatchObject({
			state: "failure",
			failure: {
				context: "ci/verify",
				run: run.number,
				job: "verify",
				unavailable: expect.any(String),
			},
		});
		expect(out.still_pending).toBeGreaterThanOrEqual(1);
		expect(polled(result)).toBe(false);
	}, 30_000);

	test("--pr waits for a missing required check", async () => {
		const { repo, cwd } = await setup();
		const base = `/repos/${repo.owner}/${repo.name}`;
		const sha = await pushBranch(server, repo, "feat/pr");
		const pr = await adminApi<{ number: number }>(server, `${base}/pulls`, {
			head: "feat/pr",
			base: "main",
			title: "Required",
		});
		await adminApi(server, `${base}/branch_protections`, {
			rule_name: "main",
			enable_status_check: true,
			status_check_contexts: ["ci/*", "Verify / verify (pull_request)"],
		});
		await post(repo, sha, { state: "success", context: "ci/lint" });
		const { result } = await wait(cwd, "--pr", String(pr.number));
		expect(await expectOk<Json>(result)).toMatchObject({
			sha,
			state: "pending",
			missing: ["Verify / verify (pull_request)"],
			next: `fgj read status wait --pr ${pr.number}`,
		});
	}, 30_000);

	test("a ref that does not exist is not_found", async () => {
		const { cwd } = await setup();
		await expectError((await wait(cwd, "nope")).result, "not_found", 4);
	});
});

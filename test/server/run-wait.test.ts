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

/** Short times for tests: a 2 s cap, 0.25 s polls, and a 1 s grace. */
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

const ONE_JOB =
	"on: [push]\njobs:\n  verify:\n    runs-on: x\n    steps:\n      - run: exit 1\n";

/**
 * The test server has no runner, so a run stays `waiting` until a REST cancel
 * makes it `cancelled`, which is done.
 */
describe("fgj read run wait", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let run: FixtureRun;
	let cwd: string;

	beforeAll(async () => {
		server = await loadServer();
		const name = `t-${crypto.randomUUID().slice(0, 8)}`;
		await adminApi(server, "/user/repos", { name, auto_init: true });
		repo = { owner: server.username, name };
		await pushWorkflow(server, repo, ONE_JOB);
		[run] = (await waitForRuns(server, repo, 1)) as [FixtureRun];
		cwd = await makeWorkDir(server, repo);
	}, 60_000);

	/** Runs the wait and measures how long the call took. */
	const wait = async (...argv: string[]) => {
		const start = Date.now();
		const result = await runFgj(
			server,
			["read", "run", "wait", ...argv],
			cwd,
			TIMES,
		);
		return { result, ms: Date.now() - start };
	};

	/** Runs a wait that the grace ends, with room for slow reads. */
	const graceWait = async (...argv: string[]) => {
		const start = Date.now();
		const result = await runFgj(
			server,
			["read", "run", "wait", ...argv],
			cwd,
			GRACE_TIMES,
		);
		return { result, ms: Date.now() - start };
	};

	test("a run that stays waiting returns at the cap with next and how long it waited, with GET only", async () => {
		const { result, ms } = await wait(String(run.number));
		const out = await expectOk<Json>(result);
		expect(out).toMatchObject({
			state: "pending",
			number: run.number,
			status: "waiting",
			next: `fgj read run wait ${run.number}`,
		});
		expect(out.pending_s).toBeLessThan(120);
		// It waited, not answered at once. The pending state proves that the cap
		// ended it; the unit tests prove the budget. No upper clock bound: other
		// test files run at the same time.
		expect(ms).toBeGreaterThanOrEqual(1000);
		expect(onlyGets(result)).toBe(true);
	});

	test("a run that ends during the call ends the wait at once", async () => {
		const [{ result }] = await Promise.all([
			wait(String(run.number)),
			Bun.sleep(300).then(() =>
				adminApi(
					server,
					`/repos/${repo.owner}/${repo.name}/actions/runs/${run.id}/cancel`,
					{},
				),
			),
		]);
		const out = await expectOk<Json>(result);
		// A cancelled run did not pass: its state is failure.
		expect(out).toMatchObject({
			state: "failure",
			number: run.number,
			status: "cancelled",
		});
		// A final state, not pending at the cap: the end of the run ended the wait.
		expect(out.next).toBeUndefined();
	});

	test("an unknown run is not_found at once; a commit with no run ends as none after the grace", async () => {
		const unknown = await wait("999");
		await expectError(unknown.result, "not_found", 4);
		expect(polled(unknown.result)).toBe(false);
		// A repository with no workflow: its commit can never get a run.
		const name = `t-${crypto.randomUUID().slice(0, 8)}`;
		await adminApi(server, "/user/repos", { name, auto_init: true });
		const sha = await pushBranch(
			server,
			{ owner: server.username, name },
			"feat/no-ci",
		);
		const quiet = await graceWait(
			"--commit",
			sha,
			"--repo",
			`${server.username}/${name}`,
		);
		expect(await expectOk<Json>(quiet.result)).toMatchObject({
			state: "none",
			commit: sha,
		});
		// It waited for the grace; none, not pending, shows that the grace ended it.
		expect(quiet.ms).toBeGreaterThanOrEqual(1000);
	}, 20_000);

	test("a commit or a pull request that does not exist stays not_found, not none", async () => {
		const commit = await wait("--commit", "0".repeat(40));
		await expectError(commit.result, "not_found", 4);
		await expectError((await wait("--pr", "99999")).result, "not_found", 4);
	});
});

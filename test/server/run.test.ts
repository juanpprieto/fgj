import { beforeAll, describe, expect, test } from "bun:test";
import {
	addPull,
	adminApi,
	expectError,
	expectOk,
	type FixtureRepo,
	type FixtureRun,
	httpCalls,
	loadServer,
	makeWorkDir,
	onlyGets,
	pushWorkflow,
	runFgj,
	type TestServer,
	waitForRuns,
} from "../support/forgejo.ts";

const TWO_JOBS =
	"on: [push, pull_request]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 1\n  second:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n";

interface RunOut {
	number: number;
	status: string;
	event: string;
	ref: string;
	sha: string;
	title: string;
	url: string;
	jobs: { name: string; status: string }[];
	as: string;
}

describe("fgj read run get and run log", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let run: FixtureRun;
	let cwd: string;

	/** A repository with a `main` branch. */
	const newRepo = async (): Promise<FixtureRepo> => {
		const name = `t-${crypto.randomUUID().slice(0, 8)}`;
		await adminApi(server, "/user/repos", { name, auto_init: true });
		return { owner: server.username, name };
	};

	beforeAll(async () => {
		server = await loadServer();
		// Another repository's run first, so this repository's run ids differ
		// from its run numbers, and no test passes by that coincidence.
		const other = await newRepo();
		await pushWorkflow(server, other, TWO_JOBS);
		await waitForRuns(server, other, 1);
		repo = await newRepo();
		await pushWorkflow(server, repo, TWO_JOBS);
		[run] = (await waitForRuns(server, repo, 1)) as [FixtureRun];
		cwd = await makeWorkDir(server, repo);
	}, 60_000);

	const fgj = (...argv: string[]) =>
		runFgj(server, ["read", "run", ...argv], cwd);

	test("run get <number> finds the run by its web number, not by its API id, with GET only", async () => {
		expect(run.id).not.toBe(run.number);
		const result = await fgj("get", String(run.number));
		const out = await expectOk<RunOut>(result);
		expect(out).toMatchObject({
			number: run.number,
			status: "waiting",
			event: "push",
			ref: "main",
			sha: run.sha,
			jobs: [
				{ name: "verify", status: "waiting" },
				{ name: "second", status: "waiting" },
			],
		});
		expect(out.url).toBe(
			`${server.url}/${repo.owner}/${repo.name}/actions/runs/${run.number}`,
		);
		expect(onlyGets(result)).toBe(true);
		expect(httpCalls(result)).toEqual([
			`GET /repos/${repo.owner}/${repo.name}/actions/runs?run_number=${run.number}&page=1&limit=1`,
			`GET /repos/${repo.owner}/${repo.name}/actions/runs/${run.id}/jobs`,
		]);
	});

	test("a run URL, a status target_url, and --commit with a short SHA give the same run", async () => {
		const byUrl = await expectOk<RunOut>(
			await fgj(
				"get",
				`${server.url}/${repo.owner}/${repo.name}/actions/runs/${run.number}`,
			),
		);
		const byTarget = await expectOk<RunOut>(
			await fgj(
				"get",
				`/${repo.owner}/${repo.name}/actions/runs/${run.number}/jobs/0`,
			),
		);
		const byCommit = await expectOk<RunOut>(
			await fgj("get", "--commit", run.sha.slice(0, 8)),
		);
		for (const out of [byUrl, byTarget, byCommit]) {
			expect(out.number).toBe(run.number);
		}
	});

	test("run log: a job that never ran reads as unavailable with Forgejo's reason; the URL's /jobs/N picks the job", async () => {
		const out = await expectOk<Record<string, unknown>>(
			await fgj(
				"log",
				`/${repo.owner}/${repo.name}/actions/runs/${run.number}/jobs/1`,
			),
		);
		expect(out).toEqual({
			number: run.number,
			job: "second",
			unavailable: "job has not been executed yet",
			// The job will run: the hint reads the same run again, by the caller's URL.
			hint: `fgj read run get /${repo.owner}/${repo.name}/actions/runs/${run.number}`,
			as: "env",
		});
		const byName = await expectOk<Record<string, unknown>>(
			await fgj("log", String(run.number), "--job", "VERIFY"),
		);
		expect(byName.job).toBe("verify");
	});

	test("run log on a run with several jobs and no failed job asks for --job and names them", async () => {
		const err = await expectError(
			await fgj("log", String(run.number)),
			"usage",
			2,
		);
		expect(err.message).toContain("0 (verify, waiting), 1 (second, waiting)");
		expect(err.hint).toBe(`fgj read run log ${run.number} --job verify`);
		const bad = await expectError(
			await fgj("log", String(run.number), "--job", "deploy"),
			"usage",
			2,
		);
		expect(bad.message).toContain('no job "deploy"');
	});

	test("--pr finds the pull request's run", async () => {
		const pr = await newRepo();
		await pushWorkflow(server, pr, TWO_JOBS);
		await waitForRuns(server, pr, 1);
		const number = await addPull(server, pr, "Run me");
		const runs = await waitForRuns(server, pr, 3);
		const prRun = runs.find((r) => r.event === "pull_request") as FixtureRun;
		const dir = await makeWorkDir(server, pr);
		const out = await expectOk<RunOut>(
			await runFgj(server, ["read", "run", "get", "--pr", String(number)], dir),
		);
		expect(out.number).toBe(prRun.number);
		expect(out.event).toBe("pull_request");
	}, 60_000);

	test("errors: a missing run, a missing commit, two ways to name a run, and a URL of another repository", async () => {
		await expectError(await fgj("get", "999"), "not_found", 4);
		await expectError(await fgj("get", "--commit", "abcdef1"), "not_found", 4);
		await expectError(
			await fgj("get", String(run.number), "--pr", "1"),
			"usage",
			2,
		);
		await expectError(await fgj("get"), "usage", 2);
		const other = await expectError(
			await fgj("get", "/someone/else/actions/runs/1"),
			"usage",
			2,
		);
		expect(other.message).toContain("Add --repo someone/else");
		await expectError(
			await fgj("log", String(run.number), "--match", "x", "--tail", "3"),
			"usage",
			2,
		);
	});
});

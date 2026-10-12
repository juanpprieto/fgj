import { beforeAll, describe, expect, test } from "bun:test";
import {
	addPull,
	adminApi,
	adminSend,
	adminWeb,
	createUser,
	expectError,
	expectOk,
	type FixtureRepo,
	type FixtureRun,
	loadServer,
	makeWorkDir,
	mintToken,
	onlyGets,
	pushWorkflow,
	runFgj,
	type TestServer,
	waitForRuns,
	webProfile,
} from "../support/forgejo.ts";

const TWO_JOBS =
	"on: [push, pull_request]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 1\n  second:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n";

interface RerunOut {
	changed: boolean;
	number: number;
	sha: string;
	attempt: number;
	url: string;
	hint: string;
	as: string;
}

interface PlanOut {
	dry_run: boolean;
	changed: boolean;
	number: number;
	sha: string;
	status: string;
	jobs: string[];
	plus?: string[];
	apply: string;
}

/** `build` hides its key behind a name; `test` needs it, and `deploy` needs `test`. */
const CHAIN =
	"on: [push]\njobs:\n  build:\n    name: Build it\n    runs-on: x\n    steps:\n      - run: exit 1\n  test:\n    runs-on: x\n    needs: build\n    steps:\n      - run: echo t\n  deploy:\n    runs-on: x\n    needs: [test]\n    steps:\n      - run: echo d\n  lint:\n    runs-on: x\n    steps:\n      - run: echo l\n";

interface ApiJob {
	name: string;
	status: string;
	attempt: number;
}

/**
 * The test server has no runner, so every run stays `waiting`. A REST cancel
 * makes a run `cancelled`, which Forgejo counts as done, so it can re-run.
 */
describe("fgj write run rerun", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let run: FixtureRun;
	let cwd: string;
	const as = { FGJ_PROFILE: "t" };

	/** A repository with a `main` branch. */
	const newRepo = async (): Promise<FixtureRepo> => {
		const name = `t-${crypto.randomUUID().slice(0, 8)}`;
		await adminApi(server, "/user/repos", { name, auto_init: true });
		return { owner: server.username, name };
	};
	const runs = () => `/repos/${repo.owner}/${repo.name}/actions/runs`;
	const cancel = (id: number) => adminApi(server, `${runs()}/${id}/cancel`, {});
	const jobs = async (id: number) =>
		(await adminApi<ApiJob[] | null>(server, `${runs()}/${id}/jobs`)) ?? [];
	const fgj = (...argv: string[]) =>
		runFgj(server, ["write", "run", "rerun", ...argv], cwd, as);

	beforeAll(async () => {
		server = await loadServer();
		// Another repository's run first, so run ids differ from run numbers.
		const other = await newRepo();
		await pushWorkflow(server, other, TWO_JOBS);
		await waitForRuns(server, other, 1);
		repo = await newRepo();
		await pushWorkflow(server, repo, TWO_JOBS);
		[run] = (await waitForRuns(server, repo, 1)) as [FixtureRun];
		cwd = await makeWorkDir(server, repo);
		await webProfile(server, cwd);
	}, 60_000);

	test("a run that has not finished is refused before any change, with a hint to read it again", async () => {
		const result = await fgj(String(run.number));
		const error = await expectError(result, "conflict", 5);
		expect(error.hint).toBe(`fgj read run get ${run.number}`);
		expect(onlyGets(result)).toBe(true);
	});

	test("--dry-run on a finished run shows the run, its head, and its jobs, and changes nothing", async () => {
		await cancel(run.id);
		const result = await fgj(String(run.number), "--dry-run");
		const out = await expectOk<PlanOut>(result);
		expect(out).toMatchObject({
			dry_run: true,
			changed: true,
			number: run.number,
			sha: run.sha,
			status: "cancelled",
			jobs: ["verify", "second"],
			apply: `fgj write run rerun ${run.number}`,
		});
		expect(onlyGets(result)).toBe(true);
		expect((await jobs(run.id)).map((j) => j.attempt)).toEqual([1, 1]);
	});

	test("a finished run re-runs on the same head, and the result names the new attempt", async () => {
		const out = await expectOk<RerunOut>(await fgj(String(run.number)));
		expect(out).toMatchObject({
			changed: true,
			number: run.number,
			sha: run.sha,
			attempt: 2,
			hint: `fgj read run get ${run.number}`,
			as: "t",
		});
		expect(out.url).toEndWith(
			`/${repo.owner}/${repo.name}/actions/runs/${run.number}/jobs/0/attempt/2`,
		);
		const after = await jobs(run.id);
		expect(after.map((j) => [j.name, j.attempt])).toEqual([
			["verify", 2],
			["second", 2],
		]);
		expect(after.every((j) => j.status === "waiting")).toBe(true);
	});

	test("--job re-runs one job, named or by index", async () => {
		await cancel(run.id);
		const out = await expectOk<RerunOut>(
			await fgj(String(run.number), "--job", "second"),
		);
		expect(out.attempt).toBe(3);
		expect(out.url).toEndWith(`/runs/${run.number}/jobs/1/attempt/3`);
		expect((await jobs(run.id)).map((j) => [j.name, j.attempt])).toEqual([
			["verify", 2],
			["second", 3],
		]);
		await cancel(run.id);
		const byIndex = await expectOk<RerunOut>(
			await fgj(String(run.number), "--job", "0"),
		);
		expect(byIndex.attempt).toBe(3);
		// A whole-run re-run would also give attempt 3 for job 0; job 1 proves it.
		expect(byIndex.url).toEndWith(`/runs/${run.number}/jobs/0/attempt/3`);
		expect((await jobs(run.id)).map((j) => [j.name, j.attempt])).toEqual([
			["verify", 3],
			["second", 3],
		]);
	});

	test("a run URL that names a job re-runs that job only", async () => {
		await cancel(run.id);
		const url = `${server.url}/${repo.owner}/${repo.name}/actions/runs/${run.number}/jobs/1`;
		const out = await expectOk<RerunOut>(await fgj(url));
		expect(out.url).toEndWith(`/runs/${run.number}/jobs/1/attempt/4`);
		expect((await jobs(run.id)).map((j) => [j.name, j.attempt])).toEqual([
			["verify", 3],
			["second", 4],
		]);
	});

	test("--job with --dry-run lists every job that needs it; a hidden job key adds plus", async () => {
		const chain = await newRepo();
		await pushWorkflow(server, chain, CHAIN);
		const [first] = (await waitForRuns(server, chain, 1)) as [FixtureRun];
		await adminApi(
			server,
			`/repos/${chain.owner}/${chain.name}/actions/runs/${first.id}/cancel`,
			{},
		);
		const dir = await makeWorkDir(server, chain);
		await webProfile(server, dir);
		const rerun = (...argv: string[]) =>
			runFgj(server, ["write", "run", "rerun", ...argv], dir, as);
		const test = await expectOk<PlanOut>(
			await rerun(String(first.number), "--job", "test", "--dry-run"),
		);
		expect(test.jobs).toEqual(["test", "deploy"]);
		// No job outside the plan has needs, so the plan is exact.
		expect(test.plus).toBeUndefined();
		const build = await expectOk<PlanOut>(
			await rerun(String(first.number), "--job", "Build it", "--dry-run"),
		);
		expect(build.jobs).toEqual(["Build it"]);
		// Its key is hidden, so the jobs with needs may re-run too.
		expect(build.plus).toEqual(["test", "deploy"]);
		// Forgejo re-runs the jobs that need the chosen one, as the plan says.
		await expectOk(await rerun(String(first.number), "--job", "test"));
		const after =
			(await adminApi<ApiJob[] | null>(
				server,
				`/repos/${chain.owner}/${chain.name}/actions/runs/${first.id}/jobs`,
			)) ?? [];
		expect(after.map((j) => [j.name, j.attempt])).toEqual([
			["Build it", 1],
			["test", 2],
			["deploy", 2],
			["lint", 1],
		]);
		// With no hidden key, the plan is exact and has no plus.
		await cancel(run.id);
		const plain = await expectOk<PlanOut>(
			await fgj(String(run.number), "--job", "second", "--dry-run"),
		);
		expect(plain.jobs).toEqual(["second"]);
		expect(plain.plus).toBeUndefined();
	}, 60_000);

	test("an account without Actions write access gets not_found, and a disabled workflow gets Forgejo's reason", async () => {
		await cancel(run.id);
		const erin = await createUser(server);
		await adminSend(
			server,
			"PUT",
			`/repos/${repo.owner}/${repo.name}/collaborators/${erin.username}`,
			{ permission: "read" },
		);
		const dir = await makeWorkDir(server, repo);
		await webProfile(server, dir, {
			name: "erin",
			login: erin,
			tokens: {
				read: await mintToken(server, erin, [
					"read:issue",
					"read:repository",
					"read:user",
				]),
				write: await mintToken(server, erin, [
					"write:issue",
					"write:repository",
					"read:user",
				]),
			},
		});
		const denied = await expectError(
			await runFgj(server, ["write", "run", "rerun", String(run.number)], dir, {
				FGJ_PROFILE: "erin",
			}),
			"not_found",
			4,
		);
		expect(denied.message).toContain("write access to Actions");
		const files = await adminApi<{ name: string }[]>(
			server,
			`/repos/${repo.owner}/${repo.name}/contents/.forgejo/workflows`,
		);
		const file = (files[0] as { name: string }).name;
		const base = `/${repo.owner}/${repo.name}/actions`;
		await adminWeb(server, `${base}/disable?workflow=${file}`, { form: {} });
		try {
			const off = await expectError(
				await fgj(String(run.number)),
				"conflict",
				5,
			);
			expect(off.hint).toBe(`fgj read run get ${run.number}`);
			expect(off.message).toMatch(/disabled/i);
		} finally {
			await adminWeb(server, `${base}/enable?workflow=${file}`, { form: {} });
		}
	}, 30_000);

	test("errors: an unknown job, an unknown run, and a profile with no web login", async () => {
		await cancel(run.id);
		const job = await expectError(
			await fgj(String(run.number), "--job", "nope"),
			"usage",
			2,
		);
		expect(job.message).toContain("0 (verify");
		await expectError(await fgj("999"), "not_found", 4);
		const bare = await makeWorkDir(server, repo);
		await webProfile(server, bare, { name: "noweb", web: false });
		const result = await runFgj(
			server,
			["write", "run", "rerun", String(run.number)],
			bare,
			{ FGJ_PROFILE: "noweb" },
		);
		const auth = await expectError(result, "auth", 3);
		expect(auth.hint).toBe("fgj auth web --profile noweb");
	});

	test("a pull_request run whose pull request head moved is refused, with a hint to the current head", async () => {
		const pr = await addPull(server, repo, "Moved head");
		const base = `/repos/${repo.owner}/${repo.name}`;
		const pull = await adminApi<{ head: { ref: string; sha: string } }>(
			server,
			`${base}/pulls/${pr}`,
		);
		// Branch pushes start their own runs; wait for the PR's run on its head.
		let old: FixtureRun | undefined;
		for (let i = 0; i < 40 && !old; i++) {
			old = (await waitForRuns(server, repo, 1)).find(
				(r) => r.event === "pull_request" && r.sha === pull.head.sha,
			);
			if (!old) await Bun.sleep(250);
		}
		if (!old) throw new Error("the pull request run never appeared");
		await cancel(old.id);
		await adminApi(server, `${base}/contents/moved-${pr}.txt`, {
			content: btoa("moved"),
			branch: pull.head.ref,
			message: "move the head",
		});
		const result = await fgj(String(old.number));
		const error = await expectError(result, "conflict", 5);
		expect(error.message).toContain(`pull request ${pr}`);
		expect(error.hint).toBe(`fgj read run get --pr ${pr}`);
		expect(onlyGets(result)).toBe(true);
	}, 30_000);
});

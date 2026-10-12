import { beforeAll, describe, expect, test } from "bun:test";
import {
	adminApi,
	createPull,
	expectError,
	expectOk,
	type FixtureRepo,
	httpCalls,
	loadServer,
	makeWorkDir,
	onlyGets,
	pushWorkflow,
	runFgj,
	type TestServer,
	waitForRuns,
} from "../support/forgejo.ts";

interface List {
	items: Record<string, unknown>[];
	total?: number;
	next: string | null;
	as: string;
}

describe("fgj read api get", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let pull: number;
	let cwd: string;

	beforeAll(async () => {
		server = await loadServer();
		const made = await createPull(server, "Six commits");
		repo = made.repo;
		pull = made.number;
		cwd = await makeWorkDir(server, repo);
		// createPull makes one commit on its branch; add five more.
		const pr = await adminApi<{ head: { ref: string } }>(
			server,
			`/repos/${repo.owner}/${repo.name}/pulls/${pull}`,
		);
		for (let i = 0; i < 5; i++) {
			await adminApi(
				server,
				`/repos/${repo.owner}/${repo.name}/contents/c${i}.txt`,
				{
					content: btoa(`c${i}`),
					branch: pr.head.ref,
					message: `feat: change ${i}\n\nThe body of change ${i}.`,
				},
			);
		}
		await commitsSettled(repo, pull, 6);
		// The cap tests share this fixture; the setup builds it, not a test.
		await longCommits();
	}, 60_000);

	/** Forgejo updates a PR's commit list a moment after a push; wait for it. */
	async function commitsSettled(r: FixtureRepo, n: number, want: number) {
		const count = async () => {
			let total = 0;
			for (let page = 1; ; page++) {
				const list = await adminApi<unknown[]>(
					server,
					`/repos/${r.owner}/${r.name}/pulls/${n}/commits?page=${page}`,
				);
				total += list.length;
				if (list.length < server.apiPage) return total;
			}
		};
		for (let i = 0; i < 40; i++) {
			if ((await count()) === want) return;
			await Bun.sleep(250);
		}
		throw new Error(`PR ${n} never showed ${want} commits`);
	}

	const api = (dir: string, ...rest: string[]) =>
		runFgj(server, ["read", "api", "get", ...rest], dir);

	test("`.` reads the repository, and --fields keeps only the named keys, in one GET", async () => {
		const result = await api(
			cwd,
			".",
			"--fields",
			"full_name,default_branch,html_url",
		);
		expect(await expectOk<Record<string, unknown>>(result)).toEqual({
			full_name: `${repo.owner}/${repo.name}`,
			default_branch: "main",
			html_url: `${server.url}/${repo.owner}/${repo.name}`,
			as: "env",
		});
		expect(httpCalls(result)).toEqual([
			`GET /repos/${repo.owner}/${repo.name}`,
		]);
	});

	test("a list returns items, total, and next from the Link header; dotted fields keep the nesting", async () => {
		const first = await expectOk<List>(
			await api(
				cwd,
				`pulls/${pull}/commits`,
				"--query",
				"limit=4",
				"--fields",
				"sha,commit.message",
			),
		);
		expect(first.items).toHaveLength(4);
		expect(Object.keys(first.items[0] ?? {}).sort()).toEqual(["commit", "sha"]);
		expect(Object.keys((first.items[0]?.commit as object) ?? {})).toEqual([
			"message",
		]);
		expect(first.total).toBe(6);
		expect(first.next).toBe(
			`fgj read api get pulls/${pull}/commits --query limit=4 --query page=2 --fields sha,commit.message`,
		);
		const second = await expectOk<List>(
			await api(
				cwd,
				`pulls/${pull}/commits`,
				"--query",
				"limit=4",
				"--query",
				"page=2",
				"--fields",
				"sha",
			),
		);
		expect(second.items).toHaveLength(2);
		expect(second.next).toBeNull();
	});

	test("dotted fields reach into a wrapper array", async () => {
		const pr = await adminApi<{ head: { sha: string } }>(
			server,
			`/repos/${repo.owner}/${repo.name}/pulls/${pull}`,
		);
		await adminApi(
			server,
			`/repos/${repo.owner}/${repo.name}/statuses/${pr.head.sha}`,
			{
				state: "success",
				context: "ci/test",
				description: "All good",
			},
		);
		const out = await expectOk<{
			state: string;
			statuses: { context: string }[];
		}>(
			await api(
				cwd,
				`commits/${pr.head.sha}/status`,
				"--fields",
				"state,statuses.context",
			),
		);
		expect(out.state).toBe("success");
		expect(out.statuses).toEqual([{ context: "ci/test" }]);
	});

	test("a nested contents path is allowed", async () => {
		const out = await expectOk<{ name: string; type: string }>(
			await api(cwd, "contents/README.md", "--fields", "name,type"),
		);
		expect(out).toMatchObject({ name: "README.md", type: "file" });
	});

	test("paths outside the accept list, traversal, and URLs fail with usage before any request", async () => {
		for (const path of [
			"actions/variables",
			"actions/secrets",
			"hooks",
			"../user",
			"pulls/../../user",
			"%2e%2e/user",
			"/repos/a/b",
			"https://example.com/api/v1/repos/a/b",
			"pulls?state=open",
			"pulls//1",
			"pulls/1.diff",
			"user",
		]) {
			const result = await api(cwd, path);
			const err = await expectError(result, "usage", 2);
			expect({ path, calls: httpCalls(result) }).toEqual({ path, calls: [] });
			expect(err.hint).toBe("fgj help api get");
		}
	});

	test("bad --query and --fields values fail with usage before any request", async () => {
		for (const argv of [
			[".", "--query", "limit"],
			[".", "--query", "Limit=5"],
			[".", "--fields"],
			[".", "--fields", "a..b"],
			[],
			[".", "pulls"],
		]) {
			const result = await api(cwd, ...argv);
			await expectError(result, "usage", 2);
			expect(httpCalls(result)).toEqual([]);
		}
	});

	/**
	 * One pull request with 9 commits whose messages are long: 2 commit
	 * objects fit under the output cap, and 4 do not. The setup makes it once.
	 */
	let longPull:
		| Promise<{ dir: string; path: string; shas: string[] }>
		| undefined;
	const longCommits = () => {
		longPull ??= (async () => {
			const long = await createPull(server, "Long messages");
			const r = long.repo;
			const head = await adminApi<{ head: { ref: string } }>(
				server,
				`/repos/${r.owner}/${r.name}/pulls/${long.number}`,
			);
			for (let i = 0; i < 8; i++) {
				await adminApi(
					server,
					`/repos/${r.owner}/${r.name}/contents/l${i}.txt`,
					{
						content: btoa(`l${i}`),
						branch: head.head.ref,
						message: `feat: long ${i}\n\n${"m".repeat(9000)}`,
					},
				);
			}
			await commitsSettled(r, long.number, 9);
			const path = `pulls/${long.number}/commits`;
			const shas: string[] = [];
			for (let page = 1; shas.length < 9; page++) {
				const got = await adminApi<{ sha: string }[]>(
					server,
					`/repos/${r.owner}/${r.name}/${path}?page=${page}`,
				);
				shas.push(...got.map((c) => c.sha));
			}
			return { dir: await makeWorkDir(server, r), path, shas };
		})();
		return longPull;
	};

	test("a result over the output cap fails with its size and a smaller-limit hint that works", async () => {
		// The short commits of the shared pull request fit under the cap.
		await expectOk(await api(cwd, `pulls/${pull}/commits`));
		const { dir, path } = await longCommits();
		const err = await expectError(await api(dir, path), "usage", 2);
		expect(err.message).toContain("28000");
		const hinted = /--query limit=(\d+)$/.exec(err.hint)?.[1];
		expect(err.hint).toBe(`fgj read api get ${path} --query limit=${hinted}`);
		const followed = await expectOk<List>(
			await api(dir, path, "--query", `limit=${hinted}`),
		);
		expect(followed.items.length).toBe(Number(hinted));
		// Fewer fields fit the whole page.
		const fitted = await expectOk<List>(
			await api(dir, path, "--fields", "sha"),
		);
		expect(fitted.items).toHaveLength(server.apiPage);
	});

	test("it sends only GET requests with the read token", async () => {
		const result = await api(cwd, "branches", "--fields", "name");
		const out = await expectOk<List>(result);
		expect(out.items.map((b) => b.name)).toContain("main");
		expect(onlyGets(result)).toBe(true);
		expect(result.trace).toContain('"kind":"read"');
	});

	test("--repo with dot parts fails before any request, for api get and for other verbs", async () => {
		for (const argv of [
			["read", "api", "get", ".", "--repo", "../user"],
			["read", "api", "get", ".", "--repo", "x/.."],
			["read", "api", "get", ".", "--repo", "x/...git"],
			["read", "issue", "get", "1", "--repo", "../user"],
		]) {
			const result = await runFgj(server, argv, await makeWorkDir(server));
			await expectError(result, "usage", 2);
			expect({ argv, calls: httpCalls(result) }).toEqual({ argv, calls: [] });
		}
	});

	test("--query keys outside the accept list fail before any request, token and sudo included", async () => {
		for (const q of ["token=x", "access_token=x", "sudo=someone", "foo=1"]) {
			const result = await api(cwd, ".", "--query", q);
			const err = await expectError(result, "usage", 2);
			expect({ q, calls: httpCalls(result) }).toEqual({ q, calls: [] });
			expect(err.message).toContain("limit");
		}
	});

	test("over the cap past page 1: a full page moves the hint's page to the same first item; the last page advises --fields only", async () => {
		const { dir, path, shas } = await longCommits();
		// Page 2 at limit 4 holds items 4-7, and a next page exists.
		const full = await expectError(
			await api(dir, path, "--query", "limit=4", "--query", "page=2"),
			"usage",
			2,
		);
		expect(full.hint).toBe(
			`fgj read api get ${path} --query limit=2 --query page=3`,
		);
		const followed = await expectOk<List>(
			await api(
				dir,
				path,
				"--query",
				"limit=2",
				"--query",
				"page=3",
				"--fields",
				"sha",
			),
		);
		expect(followed.items[0]?.sha).toBe(shas[4]);
		// Page 2 at limit 5 is the last page, and its size cannot be known.
		const last = await expectError(
			await api(dir, path, "--query", "limit=5", "--query", "page=2"),
			"usage",
			2,
		);
		expect(last.hint).toBe("fgj help api get");
		expect(last.message).toContain("--fields");
	});

	describe("Actions runs", () => {
		let runsRepo: FixtureRepo;
		let runsDir: string;
		const WF =
			"on: [push]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 1\n";

		beforeAll(async () => {
			const name = `t-${crypto.randomUUID().slice(0, 8)}`;
			await adminApi(server, "/user/repos", { name, auto_init: true });
			runsRepo = { owner: server.username, name };
			for (let i = 0; i < 3; i++) await pushWorkflow(server, runsRepo, WF);
			await waitForRuns(server, runsRepo, 3);
			runsDir = await makeWorkDir(server, runsRepo);
		}, 60_000);

		const runs = (...rest: string[]) => api(runsDir, "actions/runs", ...rest);

		test("--query limit applies on actions/runs: fgj sends page=1 with it", async () => {
			const result = await runs(
				"--query",
				"limit=1",
				"--fields",
				"workflow_runs.id",
			);
			const out = await expectOk<{ workflow_runs: unknown[] }>(result);
			expect(out.workflow_runs).toHaveLength(1);
			expect(httpCalls(result)[0]).toContain("page=1");
		});

		test("without a limit, fgj still sends page=1, so Forgejo pages actions/runs", async () => {
			const result = await runs("--fields", "workflow_runs.id");
			await expectOk(result);
			expect(httpCalls(result)[0]).toContain("page=1");
		});

		test("actions/runs and actions/tasks give next and total, from total_count", async () => {
			// The test Forgejo has no runner, so it has runs but no tasks.
			for (const [path, total] of [
				["actions/runs", 3],
				["actions/tasks", 0],
			] as const) {
				const result = await api(
					runsDir,
					path,
					"--query",
					"limit=1",
					"--fields",
					"workflow_runs.id",
				);
				const out = await expectOk<{ total: number; next: string | null }>(
					result,
				);
				// Each push adds a workflow, and all of them run on later pushes, so
				// the run count is at least the pushes, and it grows for a while.
				if (total === 0)
					expect({ path, total: out.total }).toEqual({ path, total });
				else expect(out.total).toBeGreaterThanOrEqual(total);
				expect(out.next).toBe(
					total > 1
						? `fgj read api get ${path} --query limit=1 --query page=2 --fields workflow_runs.id`
						: null,
				);
				expect(httpCalls(result)[0]).toContain("page=1");
			}
		});

		test("--query run_number is a key that fgj sends, and finds that run", async () => {
			const out = await expectOk<{
				workflow_runs: { index_in_repo: number }[];
			}>(
				await runs(
					"--query",
					"run_number=2",
					"--fields",
					"workflow_runs.index_in_repo",
				),
			);
			expect(out.workflow_runs).toEqual([{ index_in_repo: 2 }]);
		});

		test("--fields that match nothing fail, with the wrapper key in a runnable hint", async () => {
			const err = await expectError(
				await runs("--query", "limit=1", "--fields", "id,head_sha"),
				"usage",
				2,
			);
			expect(err.message).toContain("workflow_runs");
			expect(err.hint).toBe(
				"fgj read api get actions/runs --query limit=1 --fields workflow_runs.id,workflow_runs.head_sha",
			);
		});

		test("actions/runs/<n> with a web run number that is not an API id hints run get", async () => {
			const err = await expectError(
				await api(runsDir, "actions/runs/999999"),
				"not_found",
				4,
			);
			expect(err.hint).toBe("fgj read run get 999999");
			expect(err.message).toContain("API run id");
		});

		test("actions/jobs/<id> is not a path that api get reads", async () => {
			const result = await api(runsDir, "actions/jobs/1");
			await expectError(result, "usage", 2);
			expect(httpCalls(result)).toEqual([]);
		});
	});
});

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	adminApi,
	adminSend,
	checkoutBranch,
	createIssue,
	expectError,
	expectOk,
	type FixtureRepo,
	httpCalls,
	loadServer,
	makeWorkDir,
	pushBranch,
	runFgj,
	type TestServer,
	waitMergeable,
} from "../support/forgejo.ts";

/** A result object, for exact comparisons. */
type Json = Record<string, unknown>;

interface Created {
	changed: boolean;
	pr: number;
	url: string;
	as: string;
}

interface RawPull {
	number: number;
	title: string;
	body: string;
	state: string;
	draft: boolean;
	merged: boolean;
	head: { ref: string; sha: string };
	base: { ref: string };
}

describe("fgj write pr create, edit, close, and reopen", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;

	beforeAll(async () => {
		server = await loadServer();
		const name = `t-${crypto.randomUUID().slice(0, 8)}`;
		await adminApi(server, "/user/repos", { name, auto_init: true });
		repo = { owner: server.username, name };
		cwd = await makeWorkDir(server, repo);
	}, 60_000);

	const fgj = (dir: string, ...argv: string[]) =>
		runFgj(server, ["write", "pr", ...argv], dir);

	const pull = (n: number) =>
		adminApi<RawPull>(server, `/repos/${repo.owner}/${repo.name}/pulls/${n}`);

	const repoPath = () => `/repos/${repo.owner}/${repo.name}`;

	const branch = () => `feat/${crypto.randomUUID().slice(0, 8)}`;

	test("create with --head and --base sends the body byte for byte, and a repeat returns the open PR", async () => {
		const head = branch();
		await pushBranch(server, repo, head);
		const body = "## Why\r\n\r\nLogin fails.  \n";
		const file = join(cwd, "pr.md");
		await Bun.write(file, body);
		const result = await fgj(
			cwd,
			"create",
			"--title",
			"Add the login page",
			"--body-file",
			file,
			"--head",
			head,
			"--base",
			"main",
		);
		const out = await expectOk<Created>(result);
		expect(out).toEqual({
			changed: true,
			pr: out.pr,
			url: `${server.url}/${repo.owner}/${repo.name}/pulls/${out.pr}`,
			as: "env",
		});
		expect(httpCalls(result)).toEqual([
			`GET ${repoPath()}/branches/${head}`,
			`POST ${repoPath()}/pulls`,
		]);
		const made = await pull(out.pr);
		expect(made).toMatchObject({
			title: "Add the login page",
			body,
			draft: false,
			head: { ref: head },
			base: { ref: "main" },
		});

		const again = await fgj(
			cwd,
			"create",
			"--title",
			"Another title",
			"--head",
			head,
			"--base",
			"main",
		);
		expect(await expectOk<Created>(again)).toEqual({
			changed: false,
			pr: out.pr,
			url: out.url,
			as: "env",
		});
		expect(httpCalls(again)).toEqual([
			`GET ${repoPath()}/branches/${head}`,
			`POST ${repoPath()}/pulls`,
			`GET ${repoPath()}/pulls?state=open&base=main&head=${encodeURIComponent(head)}&limit=1`,
		]);
		expect((await pull(out.pr)).title).toBe("Add the login page");
	}, 20_000);

	test("create defaults --head to the checked-out branch and --base to the default branch", async () => {
		const head = branch();
		await pushBranch(server, repo, head);
		const dir = await makeWorkDir(server, repo);
		await checkoutBranch(server, dir, head);
		const result = await fgj(dir, "create", "--title", "From the checkout");
		const out = await expectOk<Created>(result);
		expect(out.changed).toBe(true);
		expect(await pull(out.pr)).toMatchObject({
			head: { ref: head },
			base: { ref: "main" },
		});
		expect(httpCalls(result)).toEqual([
			`GET ${repoPath()}`,
			`GET ${repoPath()}/branches/${head}`,
			`POST ${repoPath()}/pulls`,
		]);
	}, 20_000);

	test("create refuses a checkout that the server lacks or has at another commit, before the create", async () => {
		const head = branch();
		await pushBranch(server, repo, head);
		const dir = await makeWorkDir(server, repo);
		await checkoutBranch(server, dir, head);
		const commit = Bun.spawnSync(
			[
				"git",
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@example.invalid",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"local only",
			],
			{ cwd: dir },
		);
		expect(commit.exitCode).toBe(0);
		const ahead = await fgj(dir, "create", "--title", "Ahead");
		const err = await expectError(ahead, "conflict", 5);
		expect(err.message).toContain(`The server has ${head} at`);
		expect(httpCalls(ahead).some((c) => c.startsWith("POST"))).toBe(false);

		const renamed = Bun.spawnSync(
			["git", "branch", "-q", "-m", "feat/nowhere"],
			{
				cwd: dir,
			},
		);
		expect(renamed.exitCode).toBe(0);
		const missing = await fgj(dir, "create", "--title", "Missing");
		const gone = await expectError(missing, "not_found", 4);
		expect(gone.message).toContain("git push -u origin feat/nowhere");
		expect(httpCalls(missing).some((c) => c.startsWith("POST"))).toBe(false);
	}, 20_000);

	test("create --draft adds the WIP: prefix, and pr get reads it as a draft", async () => {
		const head = branch();
		await pushBranch(server, repo, head);
		const out = await expectOk<Created>(
			await fgj(cwd, "create", "--title", "Try it", "--head", head, "--draft"),
		);
		expect(await pull(out.pr)).toMatchObject({
			title: "WIP: Try it",
			draft: true,
		});
		const read = await expectOk<{ draft: boolean }>(
			await runFgj(server, ["read", "pr", "get", String(out.pr)], cwd),
		);
		expect(read.draft).toBe(true);
	}, 20_000);

	test("create --dry-run predicts a new PR and a repeat, and sends nothing", async () => {
		const head = branch();
		await pushBranch(server, repo, head);
		const plan = await fgj(
			cwd,
			"create",
			"--title",
			"Planned",
			"--head",
			head,
			"--dry-run",
		);
		expect(await expectOk<Json>(plan)).toEqual({
			dry_run: true,
			changed: true,
			apply: `fgj write pr create --title Planned --head ${head}`,
			as: "env",
		});
		expect(httpCalls(plan).some((c) => !c.startsWith("GET"))).toBe(false);
		const made = await expectOk<Created>(
			await fgj(cwd, "create", "--title", "Planned", "--head", head),
		);
		expect(
			await expectOk<Json>(
				await fgj(
					cwd,
					"create",
					"--title",
					"Planned",
					"--head",
					head,
					"--dry-run",
				),
			),
		).toMatchObject({ dry_run: true, changed: false, pr: made.pr });
	}, 20_000);

	test("create usage errors: owner:branch, head equal to base, a WIP: title, no title, a detached checkout", async () => {
		for (const argv of [
			["--title", "X", "--head", `${repo.owner}:main`],
			["--title", "X", "--head", "main", "--base", "main"],
			["--title", "WIP: X", "--head", "feat/x"],
			["--title", "[wip] X", "--head", "feat/x"],
			["--head", "feat/x"],
		]) {
			const result = await fgj(cwd, "create", ...argv);
			await expectError(result, "usage", 2);
			expect(httpCalls(result)).toEqual([]);
		}
		// The work dir from makeWorkDir has no commit, so no branch is checked out.
		const none = await expectError(
			await fgj(cwd, "create", "--title", "X"),
			"usage",
			2,
		);
		expect(none.message).toContain("Give --head BRANCH");
		// A default base equal to the head is found after the repository read.
		const same = await fgj(cwd, "create", "--title", "X", "--head", "main");
		await expectError(same, "usage", 2);
		expect(httpCalls(same)).toEqual([`GET ${repoPath()}`]);
	}, 20_000);

	test("create with a head the server lacks fails with not_found before the create, in the dry run too", async () => {
		for (const extra of [[], ["--dry-run"]]) {
			const result = await fgj(
				cwd,
				"create",
				"--title",
				"X",
				"--head",
				"feat/none",
				...extra,
			);
			const err = await expectError(result, "not_found", 4);
			expect(err.message).toContain("The server has no branch feat/none");
			expect(httpCalls(result).some((c) => !c.startsWith("GET"))).toBe(false);
		}
	});

	test("edit sends only the fields that change; a repeat returns changed:false with no PATCH", async () => {
		const head = branch();
		await pushBranch(server, repo, head);
		const { pr } = await expectOk<Created>(
			await fgj(cwd, "create", "--title", "Old", "--head", head),
		);
		const file = join(cwd, `edit-${pr}.md`);
		await Bun.write(file, "New body\r\n");
		const first = await fgj(
			cwd,
			"edit",
			String(pr),
			"--title",
			"New",
			"--body-file",
			file,
		);
		expect(await expectOk<Json>(first)).toEqual({
			changed: true,
			pr,
			as: "env",
		});
		expect(await pull(pr)).toMatchObject({
			title: "New",
			body: "New body\r\n",
		});
		const again = await fgj(
			cwd,
			"edit",
			String(pr),
			"--title",
			"New",
			"--body-file",
			file,
		);
		expect(await expectOk<Json>(again)).toEqual({
			changed: false,
			pr,
			as: "env",
		});
		expect(httpCalls(again)).toEqual([`GET ${repoPath()}/pulls/${pr}`]);
	}, 20_000);

	test("edit --draft and --ready change the WIP: prefix; --title on a draft keeps it", async () => {
		const head = branch();
		await pushBranch(server, repo, head);
		const { pr } = await expectOk<Created>(
			await fgj(cwd, "create", "--title", "Feature", "--head", head),
		);
		const n = String(pr);
		await expectOk<Json>(await fgj(cwd, "edit", n, "--draft"));
		expect(await pull(pr)).toMatchObject({
			title: "WIP: Feature",
			draft: true,
		});
		await expectOk<Json>(
			await fgj(cwd, "edit", n, "--title", "Better feature"),
		);
		expect(await pull(pr)).toMatchObject({
			title: "WIP: Better feature",
			draft: true,
		});
		expect(
			await expectOk<Json>(await fgj(cwd, "edit", n, "--draft")),
		).toMatchObject({
			changed: false,
		});
		await expectOk<Json>(await fgj(cwd, "edit", n, "--ready"));
		expect(await pull(pr)).toMatchObject({
			title: "Better feature",
			draft: false,
		});
		const plan = await expectOk<Json>(
			await fgj(cwd, "edit", n, "--draft", "--dry-run"),
		);
		expect(plan).toEqual({
			dry_run: true,
			changed: true,
			pr,
			apply: `fgj write pr edit ${pr} --draft`,
			as: "env",
		});
		expect((await pull(pr)).draft).toBe(false);
	}, 20_000);

	test("edit errors: nothing to change, --draft with --ready, and an issue number", async () => {
		await expectError(await fgj(cwd, "edit", "1"), "usage", 2);
		await expectError(
			await fgj(cwd, "edit", "1", "--draft", "--ready"),
			"usage",
			2,
		);
		const issue = await createIssue(server, repo, "Not a PR");
		const err = await expectError(
			await fgj(cwd, "edit", String(issue), "--title", "X"),
			"not_found",
			4,
		);
		expect(err.message).toContain("is an issue, not a pull request");
		expect(err.hint).toBe(`fgj read issue get ${issue}`);
		await expectError(
			await fgj(cwd, "edit", "9999", "--ready"),
			"not_found",
			4,
		);
	}, 20_000);

	test("close and reopen one PR; a repeat returns changed:false", async () => {
		const head = branch();
		await pushBranch(server, repo, head);
		const { pr } = await expectOk<Created>(
			await fgj(cwd, "create", "--title", "Close me", "--head", head),
		);
		const n = String(pr);
		expect(await expectOk<Json>(await fgj(cwd, "close", n))).toEqual({
			changed: true,
			pr,
			as: "env",
		});
		expect((await pull(pr)).state).toBe("closed");
		const again = await fgj(cwd, "close", n);
		expect(await expectOk<Json>(again)).toEqual({
			changed: false,
			pr,
			as: "env",
		});
		expect(httpCalls(again)).toEqual([`GET ${repoPath()}/pulls/${pr}`]);
		expect(
			await expectOk<Json>(await fgj(cwd, "reopen", n, "--dry-run")),
		).toEqual({
			dry_run: true,
			changed: true,
			pr,
			apply: `fgj write pr reopen ${pr}`,
			as: "env",
		});
		expect(await expectOk<Json>(await fgj(cwd, "reopen", n))).toEqual({
			changed: true,
			pr,
			as: "env",
		});
		expect((await pull(pr)).state).toBe("open");
	}, 20_000);

	test("close on many: a merged PR fails with conflict before any PATCH, and the others still close", async () => {
		const heads = [branch(), branch()];
		const prs: number[] = [];
		for (const head of heads) {
			await pushBranch(server, repo, head);
			prs.push(
				(
					await expectOk<Created>(
						await fgj(cwd, "create", "--title", head, "--head", head),
					)
				).pr,
			);
		}
		const [merged, open] = prs as [number, number];
		await waitMergeable(server, repo, merged);
		await adminApi(server, `${repoPath()}/pulls/${merged}/merge`, {
			Do: "merge",
		});
		const result = await fgj(cwd, "close", String(merged), String(open));
		expect(result.code).toBe(5);
		const out = JSON.parse(result.stdout) as {
			changed: boolean;
			items: { pr: number; changed?: boolean; error?: { code: string } }[];
		};
		expect(out.changed).toBe(true);
		expect(out.items).toEqual([
			{ pr: merged, error: expect.objectContaining({ code: "conflict" }) },
			{ pr: open, changed: true },
		]);
		expect(httpCalls(result).filter((c) => c.startsWith("PATCH"))).toEqual([
			`PATCH ${repoPath()}/pulls/${open}`,
		]);
		expect(await pull(merged)).toMatchObject({ merged: true, state: "closed" });
	}, 20_000);

	test("reopen of a PR that a fixture closed", async () => {
		const head = branch();
		await pushBranch(server, repo, head);
		const { pr } = await expectOk<Created>(
			await fgj(cwd, "create", "--title", "Closed by hand", "--head", head),
		);
		await adminSend(server, "PATCH", `${repoPath()}/pulls/${pr}`, {
			state: "closed",
		});
		expect(await expectOk<Json>(await fgj(cwd, "reopen", String(pr)))).toEqual({
			changed: true,
			pr,
			as: "env",
		});
	}, 20_000);
});

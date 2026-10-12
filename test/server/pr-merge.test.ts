import { beforeAll, describe, expect, test } from "bun:test";
import {
	adminApi,
	adminSend,
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
	waitMergeable,
} from "../support/forgejo.ts";

/** A result object, for exact comparisons. */
type Json = Record<string, unknown>;

interface RawPull {
	number: number;
	merged: boolean;
	merge_commit_sha: string | null;
	head: { ref: string; sha: string };
}

describe("fgj destroy pr merge", () => {
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

	/** Opens a PR from a new branch, and waits until Forgejo has checked it. */
	const openPull = async (
		repo: FixtureRepo,
		title = "Add a file",
		file?: { path: string; text: string },
	) => {
		const head = `feat/${crypto.randomUUID().slice(0, 8)}`;
		const sha = await pushBranch(server, repo, head, file);
		const pull = await adminApi<RawPull>(
			server,
			`/repos/${repo.owner}/${repo.name}/pulls`,
			{ head, base: "main", title },
		);
		// Forgejo reports a draft as not mergeable.
		if (!/^WIP:/i.test(title)) await waitMergeable(server, repo, pull.number);
		return { pr: pull.number, head, sha };
	};

	const pull = (repo: FixtureRepo, n: number) =>
		adminApi<RawPull>(server, `/repos/${repo.owner}/${repo.name}/pulls/${n}`);

	const merge = (cwd: string, ...argv: string[]) =>
		runFgj(server, ["destroy", "pr", "merge", ...argv], cwd);

	test("a merge without --style fails with usage before any request, and the hint is the dry run", async () => {
		const { cwd } = await setup();
		const result = await merge(cwd, "7");
		const err = await expectError(result, "usage", 2);
		expect(err.hint).toBe("fgj destroy pr merge 7 --dry-run");
		expect(httpCalls(result)).toEqual([]);
	});

	test("the dry run reads the default style, the head, and the checks; its apply merges and keeps the branch", async () => {
		const { repo, cwd } = await setup();
		const { pr, head, sha } = await openPull(repo, "Ship it");
		const plan = await merge(cwd, String(pr), "--dry-run");
		expect(await expectOk<Json>(plan)).toEqual({
			dry_run: true,
			changed: true,
			pr,
			title: "Ship it",
			base: "main",
			head: sha,
			style: "merge",
			checks: "none",
			apply: `fgj destroy pr merge ${pr} --style merge --head ${sha}`,
			as: "env",
		});
		expect(onlyGets(plan)).toBe(true);
		expect((await pull(repo, pr)).merged).toBe(false);

		const argv = (
			(await expectOk<{ apply: string }>(plan)).apply.split(" ") as string[]
		).slice(4);
		const done = await merge(cwd, ...argv);
		const out = await expectOk<Json>(done);
		const after = await pull(repo, pr);
		expect(after.merged).toBe(true);
		expect(out).toEqual({
			changed: true,
			pr,
			merge_commit: after.merge_commit_sha as string,
			as: "env",
		});
		const path = `/repos/${repo.owner}/${repo.name}/pulls/${pr}`;
		expect(httpCalls(done)).toEqual([
			`GET ${path}`,
			`POST ${path}/merge`,
			`GET ${path}`,
		]);
		// fgj keeps the head branch.
		await adminApi(
			server,
			`/repos/${repo.owner}/${repo.name}/branches/${head}`,
		);

		const again = await merge(cwd, String(pr), "--style", "merge");
		expect(await expectOk<Json>(again)).toEqual({
			changed: false,
			pr,
			merge_commit: after.merge_commit_sha as string,
			as: "env",
		});
		expect(onlyGets(again)).toBe(true);
		expect(
			await expectOk<Json>(await merge(cwd, String(pr), "--dry-run")),
		).toMatchObject({
			dry_run: true,
			changed: false,
			apply: `fgj destroy pr merge ${pr} --style merge`,
		});
	}, 30_000);

	test("the dry run shows a pending check, and a branch protection refusal is a conflict with a hint to read the checks", async () => {
		const { repo, cwd } = await setup();
		const { pr, sha } = await openPull(repo);
		await adminApi(
			server,
			`/repos/${repo.owner}/${repo.name}/statuses/${sha}`,
			{
				state: "pending",
				context: "ci/verify",
			},
		);
		expect(
			await expectOk<Json>(await merge(cwd, String(pr), "--dry-run")),
		).toMatchObject({ checks: "pending" });
		await adminApi(
			server,
			`/repos/${repo.owner}/${repo.name}/branch_protections`,
			{
				rule_name: "main",
				enable_status_check: true,
				status_check_contexts: ["ci/verify"],
			},
		);
		const result = await merge(cwd, String(pr), "--style", "merge");
		const err = await expectError(result, "conflict", 5);
		expect(err.message).toContain("Not all required status checks successful");
		expect(err.hint).toBe(`fgj read status get --pr ${pr}`);
		expect((await pull(repo, pr)).merged).toBe(false);
		// A PR URL from a directory with no origin: the hint keeps the repository.
		const url = `${server.url}/${repo.owner}/${repo.name}/pulls/${pr}`;
		const bare = await makeWorkDir(server);
		for (const extra of [[], ["--repo", `${repo.owner}/${repo.name}`]]) {
			const byUrl = await expectError(
				await merge(bare, url, "--style", "merge", ...extra),
				"conflict",
				5,
			);
			expect(byUrl.hint).toBe(
				`fgj read status get --pr ${pr} --repo ${repo.owner}/${repo.name}`,
			);
		}
	}, 30_000);

	test("the dry run counts a required check that never reported as pending, and names it", async () => {
		const { repo, cwd } = await setup();
		const { pr } = await openPull(repo);
		await adminApi(
			server,
			`/repos/${repo.owner}/${repo.name}/branch_protections`,
			{
				rule_name: "main",
				enable_status_check: true,
				status_check_contexts: ["Verify / *"],
			},
		);
		expect(
			await expectOk<Json>(await merge(cwd, String(pr), "--dry-run")),
		).toMatchObject({ checks: "pending", missing_checks: ["Verify / *"] });
	}, 30_000);

	test("a draft, a closed PR, and a PR that cannot merge fail with conflict and send no merge", async () => {
		const { repo, cwd } = await setup();
		const path = `/repos/${repo.owner}/${repo.name}/pulls`;
		const draft = await openPull(repo, "WIP: Not yet");
		const closed = await openPull(repo);
		await adminSend(server, "PATCH", `${path}/${closed.pr}`, {
			state: "closed",
		});
		const same = { path: "shared.txt", text: "one" };
		const first = await openPull(repo, "First", same);
		const second = await openPull(repo, "Second", {
			path: "shared.txt",
			text: "two",
		});
		await adminApi(server, `${path}/${first.pr}/merge`, { Do: "merge" });
		await waitMergeable(server, repo, second.pr, false);
		for (const [pr, text, hint] of [
			[draft.pr, "is a draft", `fgj write pr edit ${draft.pr} --ready`],
			[closed.pr, "is closed", `fgj write pr reopen ${closed.pr}`],
			[
				second.pr,
				"cannot merge",
				`fgj read pr get ${second.pr} --fields number,mergeable,head_sha`,
			],
		] as const) {
			for (const extra of [[], ["--dry-run"]]) {
				const result = await merge(
					cwd,
					String(pr),
					"--style",
					"merge",
					...extra,
				);
				const err = await expectError(result, "conflict", 5);
				expect({ pr, message: err.message, hint: err.hint }).toEqual({
					pr,
					message: expect.stringContaining(text),
					hint,
				});
				expect(onlyGets(result)).toBe(true);
			}
		}
	}, 60_000);

	test("--head with a moved head fails with conflict, and the hint is a new dry run", async () => {
		const { repo, cwd } = await setup();
		const { pr, sha } = await openPull(repo);
		const old = "0".repeat(40);
		for (const extra of [[], ["--dry-run"]]) {
			const result = await merge(
				cwd,
				String(pr),
				"--style",
				"merge",
				"--head",
				old,
				...extra,
			);
			const err = await expectError(result, "conflict", 5);
			expect(err.message).toContain(`moved to ${sha.slice(0, 10)}`);
			expect(err.hint).toBe(
				`fgj destroy pr merge ${pr} --style merge --dry-run`,
			);
			expect(onlyGets(result)).toBe(true);
		}
		await expectError(
			await merge(cwd, String(pr), "--style", "merge", "--head", "abc1234"),
			"usage",
			2,
		);
		await expectError(
			await merge(cwd, String(pr), "--style", "manually-merged"),
			"usage",
			2,
		);
	}, 30_000);

	test("a style that the repository does not allow is a conflict, in the dry run and in the merge", async () => {
		const { repo, cwd } = await setup();
		// A settings change starts a new merge check, so it comes before the PR.
		await adminSend(server, "PATCH", `/repos/${repo.owner}/${repo.name}`, {
			allow_squash_merge: false,
		});
		const { pr } = await openPull(repo);
		const plan = await expectError(
			await merge(cwd, String(pr), "--style", "squash", "--dry-run"),
			"conflict",
			5,
		);
		expect(plan.message).toContain("squash is not an allowed merge style");
		expect(plan.hint).toBe(`fgj destroy pr merge ${pr} --dry-run`);
		const real = await expectError(
			await merge(cwd, String(pr), "--style", "squash"),
			"conflict",
			5,
		);
		expect(real.message).toBe(
			"Forgejo refused the merge: squash is not an allowed merge style for this repository",
		);
		expect(real.hint).toBe(`fgj destroy pr merge ${pr} --dry-run`);
		expect((await pull(repo, pr)).merged).toBe(false);
	}, 30_000);

	test("a style that conflicts is a refusal with git's conflict line after exactly one merge request", async () => {
		const { repo, cwd } = await setup();
		const base = `/repos/${repo.owner}/${repo.name}`;
		// The head changes f.txt to b, then c; main changes it to c. A merge
		// commit is clean, and a rebase of the first head commit conflicts.
		const made = await adminApi<{ content: { sha: string } }>(
			server,
			`${base}/contents/f.txt`,
			{ content: btoa("a\n"), message: "a", branch: "main" },
		);
		await adminApi(server, `${base}/branches`, { new_branch_name: "x" });
		let sha = made.content.sha;
		for (const text of ["b", "c"]) {
			const next = await adminSend<{ content: { sha: string } }>(
				server,
				"PUT",
				`${base}/contents/f.txt`,
				{ content: btoa(`${text}\n`), message: text, branch: "x", sha },
			);
			sha = next.content.sha;
		}
		await adminSend(server, "PUT", `${base}/contents/f.txt`, {
			content: btoa("c\n"),
			message: "c on main",
			branch: "main",
			sha: made.content.sha,
		});
		const { number: pr } = await adminApi<{ number: number }>(
			server,
			`${base}/pulls`,
			{ head: "x", base: "main", title: "Rebase me" },
		);
		await waitMergeable(server, repo, pr);
		const result = await merge(cwd, String(pr), "--style", "rebase");
		const err = await expectError(result, "conflict", 5);
		expect(err.message).toBe(
			"Forgejo refused the merge: rebase conflict: CONFLICT (content): Merge conflict in f.txt",
		);
		expect(err.hint).toBe(`fgj read pr get ${pr}`);
		expect(httpCalls(result)).toEqual([
			`GET ${base}/pulls/${pr}`,
			`POST ${base}/pulls/${pr}/merge`,
			`GET ${base}/pulls/${pr}`,
		]);
		expect((await pull(repo, pr)).merged).toBe(false);
	}, 30_000);

	test("an issue number fails with not_found and names the issue", async () => {
		const { repo, cwd } = await setup();
		const issue = await createIssue(server, repo, "Not a PR");
		const err = await expectError(
			await merge(cwd, String(issue), "--style", "merge"),
			"not_found",
			4,
		);
		expect(err.message).toContain("is an issue, not a pull request");
	});
});

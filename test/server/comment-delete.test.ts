import { beforeAll, describe, expect, test } from "bun:test";
import {
	addComment,
	createIssue,
	createRepo,
	createUser,
	expectError,
	expectOk,
	type FixtureRepo,
	httpCalls,
	loadServer,
	makeWorkDir,
	onlyGets,
	readComments,
	runFgj,
	type TestServer,
} from "../support/forgejo.ts";

interface Deleted {
	changed: boolean;
	id: number;
	as: string;
}

const argvOf = (command: string) => command.split(" ").slice(1);

describe("fgj destroy comment delete", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;
	let issue: number;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		cwd = await makeWorkDir(server, repo);
		issue = await createIssue(server, repo, "Clean up a bad post");
	}, 60_000);

	const del = (...rest: string[]) =>
		runFgj(server, ["destroy", "comment", "delete", ...rest], cwd);

	const ids = async () =>
		(await readComments(server, repo, issue)).map((c) => c.id);

	test("deletes your comment and returns only changed and id", async () => {
		const id = await addComment(server, repo, issue, "Duplicate post");
		const result = await del(String(id));
		expect(await expectOk<Deleted>(result)).toEqual({
			changed: true,
			id,
			as: "env",
		});
		expect(await ids()).not.toContain(id);
		expect(httpCalls(result).filter((c) => !c.startsWith("GET"))).toEqual([
			`DELETE /repos/${repo.owner}/${repo.name}/issues/comments/${id}`,
		]);
	});

	test("a missing comment returns changed:false and sends no DELETE", async () => {
		const id = await addComment(server, repo, issue, "Gone soon");
		await expectOk(await del(String(id)));
		const again = await del(String(id));
		expect(await expectOk<Deleted>(again)).toEqual({
			changed: false,
			id,
			as: "env",
		});
		expect(onlyGets(again)).toBe(true);
	});

	test("a missing repository fails with not_found, not changed:false", async () => {
		const result = await del(
			"999999999",
			"--repo",
			`${repo.owner}/no-such-repo`,
		);
		await expectError(result, "not_found", 4);
	});

	test("a comment that lives in another repository fails with not_found and stays", async () => {
		const other = await createRepo(server);
		const otherIssue = await createIssue(server, other, "Elsewhere");
		const id = await addComment(server, other, otherIssue, "Not in repo A");
		for (const flags of [[], ["--dry-run"]]) {
			const result = await del(String(id), ...flags);
			const err = await expectError(result, "not_found", 4);
			expect(err.message).toContain(`${repo.owner}/${repo.name}`);
		}
		expect(
			(await readComments(server, other, otherIssue)).map((c) => c.id),
		).toContain(id);
	});

	test("a comment URL works from a directory with no git origin, and a repeat is changed:false", async () => {
		const id = await addComment(server, repo, issue, "Delete by URL");
		const url = `${server.url}/${repo.owner}/${repo.name}/issues/${issue}#issuecomment-${id}`;
		const bare = await makeWorkDir(server);
		const plan = await expectOk<Record<string, unknown>>(
			await runFgj(
				server,
				["destroy", "comment", "delete", url, "--dry-run"],
				bare,
			),
		);
		expect(plan.apply).toBe(`fgj destroy comment delete '${url}'`);
		const real = await runFgj(
			server,
			["destroy", "comment", "delete", url],
			bare,
		);
		expect(await expectOk<Deleted>(real)).toEqual({
			changed: true,
			id,
			as: "env",
		});
		expect(await ids()).not.toContain(id);
		const again = await runFgj(
			server,
			["destroy", "comment", "delete", url],
			bare,
		);
		expect((await expectOk<Deleted>(again)).changed).toBe(false);
	});

	test("another author's comment fails with conflict and sends no DELETE", async () => {
		const bob = await createUser(server);
		const id = await addComment(server, repo, issue, "Bob's review", bob);
		const result = await del(String(id));
		const err = await expectError(result, "conflict", 5);
		expect(err.message).toContain(bob.username);
		expect(err.hint).toBe("fgj help comment delete");
		expect(onlyGets(result)).toBe(true);
		expect(await ids()).toContain(id);
	});

	test("--dry-run deletes nothing, names the comment, and gives the exact apply command", async () => {
		const id = await addComment(server, repo, issue, "Maybe delete");
		const result = await del(String(id), "--dry-run");
		const plan = await expectOk<Record<string, unknown>>(result);
		expect(plan).toEqual({
			dry_run: true,
			changed: true,
			id,
			issue,
			created_at: expect.any(String),
			url: `${server.url}/${repo.owner}/${repo.name}/issues/${issue}#issuecomment-${id}`,
			apply: `fgj destroy comment delete ${id}`,
			as: "env",
		});
		expect(onlyGets(result)).toBe(true);
		expect(await ids()).toContain(id);

		await expectOk(await runFgj(server, argvOf(String(plan.apply)), cwd));
		expect(await ids()).not.toContain(id);
	});

	test("the write risk class is refused before any request", async () => {
		const id = await addComment(server, repo, issue, "Keep me");
		const result = await runFgj(
			server,
			["write", "comment", "delete", String(id)],
			cwd,
		);
		const err = await expectError(result, "risk_mismatch", 6);
		expect(err.hint).toBe(`fgj destroy comment delete ${id}`);
		expect(httpCalls(result)).toEqual([]);
		expect(await ids()).toContain(id);
	});
});

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	addComment,
	adminApi,
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
	runFgj,
	type TestServer,
} from "../support/forgejo.ts";

interface Edited {
	changed: boolean;
	id: number;
	as: string;
}

const argvOf = (command: string) => command.split(" ").slice(1);

describe("fgj write comment edit", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;
	let issue: number;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		cwd = await makeWorkDir(server, repo);
		issue = await createIssue(server, repo, "Keep a living list");
	}, 60_000);

	/** Writes a body file in the work dir and returns its path. */
	async function bodyFile(text: string): Promise<string> {
		const file = join(cwd, `b-${crypto.randomUUID().slice(0, 8)}.md`);
		await Bun.write(file, text);
		return file;
	}

	const edit = (...rest: string[]) =>
		runFgj(server, ["write", "comment", "edit", ...rest], cwd);

	const bodyOf = async (id: number) =>
		(
			await adminApi<{ body: string }>(
				server,
				`/repos/${repo.owner}/${repo.name}/issues/comments/${id}`,
			)
		).body;

	test("edits your comment and returns only changed and id", async () => {
		const id = await addComment(server, repo, issue, "- [ ] ship");
		const result = await edit(
			String(id),
			"--body-file",
			await bodyFile("- [x] ship\n\n"),
		);
		expect(await expectOk<Edited>(result)).toEqual({
			changed: true,
			id,
			as: "env",
		});
		expect(result.stdout).not.toContain("ship");
		// The body is sent exactly as the file holds it, as for comment add.
		expect(await bodyOf(id)).toBe("- [x] ship\n\n");
		expect(httpCalls(result).filter((c) => c.startsWith("PATCH"))).toEqual([
			`PATCH /repos/${repo.owner}/${repo.name}/issues/comments/${id}`,
		]);
	});

	test("the same bytes return changed:false and send no PATCH; other line endings are a change", async () => {
		const id = await addComment(server, repo, issue, "Same\r\ntext");
		const result = await edit(
			String(id),
			"--body-file",
			await bodyFile("Same\r\ntext"),
		);
		expect((await expectOk<Edited>(result)).changed).toBe(false);
		expect(onlyGets(result)).toBe(true);
		const lf = await edit(
			String(id),
			"--body-file",
			await bodyFile("Same\ntext"),
		);
		expect((await expectOk<Edited>(lf)).changed).toBe(true);
	});

	test("a comment URL works from a directory with no git origin", async () => {
		const id = await addComment(server, repo, issue, "old");
		const url = `${server.url}/${repo.owner}/${repo.name}/issues/${issue}#issuecomment-${id}`;
		const file = await bodyFile("new");
		const out = await expectOk<Edited>(
			await runFgj(
				server,
				["write", "comment", "edit", url, "--body-file", file],
				await makeWorkDir(server),
			),
		);
		expect(out).toMatchObject({ changed: true, id });
		expect(await bodyOf(id)).toBe("new");
	});

	test("another author's comment fails with conflict, names the author, and sends no PATCH", async () => {
		const bob = await createUser(server);
		const id = await addComment(server, repo, issue, "Bob's words", bob);
		const result = await edit(
			String(id),
			"--body-file",
			await bodyFile("Rewritten"),
		);
		const err = await expectError(result, "conflict", 5);
		expect(err.message).toContain(bob.username);
		expect(err.hint).toBe("fgj help comment edit");
		expect(onlyGets(result)).toBe(true);
		expect(await bodyOf(id)).toBe("Bob's words");
	});

	test("a missing comment fails with not_found and sends no PATCH", async () => {
		const result = await edit("999999999", "--body-file", await bodyFile("x"));
		await expectError(result, "not_found", 4);
		expect(onlyGets(result)).toBe(true);
	});

	test("--dry-run writes nothing and gives the exact apply command", async () => {
		const id = await addComment(server, repo, issue, "before");
		const file = await bodyFile("after");
		const result = await edit(String(id), "--body-file", file, "--dry-run");
		const plan = await expectOk<Record<string, unknown>>(result);
		expect(plan).toEqual({
			dry_run: true,
			changed: true,
			id,
			body_chars: 5,
			apply: `fgj write comment edit ${id} --body-file ${file}`,
			as: "env",
		});
		expect(onlyGets(result)).toBe(true);
		expect(await bodyOf(id)).toBe("before");

		await expectOk(await runFgj(server, argvOf(String(plan.apply)), cwd));
		expect(await bodyOf(id)).toBe("after");
	});

	test("--dry-run on another author's comment fails as the real run does", async () => {
		const carol = await createUser(server);
		const id = await addComment(server, repo, issue, "Carol's", carol);
		const result = await edit(
			String(id),
			"--body-file",
			await bodyFile("x"),
			"--dry-run",
		);
		await expectError(result, "conflict", 5);
	});
});

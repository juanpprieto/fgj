import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
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

interface Added {
	changed: boolean;
	issue: number;
	id: number;
	url: string;
	as?: string;
}

interface DryRun {
	dry_run: true;
	changed: boolean;
	issue: number;
	url: string;
	body_chars: number;
	apply: string;
	as?: string;
}

const argvOf = (command: string) => command.split(" ").slice(1);

describe("fgj write comment add", () => {
	let server: TestServer;
	let repo: FixtureRepo;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
	}, 60_000);

	/** A work dir with origin set and a body file `c.md` in it. */
	async function setup(body: string) {
		const cwd = await makeWorkDir(server, repo);
		const file = join(cwd, "c.md");
		await Bun.write(file, body);
		const issue = await createIssue(server, repo, "Decide the shape");
		return { cwd, file, issue };
	}

	const add = (cwd: string, ...rest: string[]) =>
		runFgj(server, ["write", "comment", "add", ...rest], cwd);

	test("adds a comment and returns only changed, issue, id, and url", async () => {
		const { cwd, file, issue } = await setup("Decision: ship it.\n\n");
		const result = await add(cwd, String(issue), "--body-file", file);
		const out = await expectOk<Added>(result);

		expect(Object.keys(out).sort()).toEqual([
			"as",
			"changed",
			"id",
			"issue",
			"url",
		]);
		expect(out).toMatchObject({ changed: true, issue });
		expect(out.url).toEndWith(`/issues/${issue}#issuecomment-${out.id}`);
		expect(result.stdout).not.toContain("Decision");
		// The body is posted exactly as the file holds it.
		expect(await readComments(server, repo, issue)).toEqual([
			{ id: out.id, author: server.username, body: "Decision: ship it.\n\n" },
		]);
		expect(httpCalls(result).filter((c) => c.startsWith("POST"))).toHaveLength(
			1,
		);
	});

	test("a retry with the same body returns changed:false and posts nothing", async () => {
		const { cwd, file, issue } = await setup("Same text\n");
		const first = await expectOk<Added>(
			await add(cwd, String(issue), "--body-file", file),
		);
		const retry = await add(cwd, String(issue), "--body-file", file);
		expect(await expectOk<Added>(retry)).toEqual({ ...first, changed: false });
		expect(httpCalls(retry).some((c) => c.startsWith("POST"))).toBe(false);
		expect(await readComments(server, repo, issue)).toHaveLength(1);
	});

	test("a body file is posted byte for byte, and only the same bytes count as a retry", async () => {
		const { cwd, file, issue } = await setup("Line one  \r\nLine two\r\n\r\n");
		const first = await expectOk<Added>(
			await add(cwd, String(issue), "--body-file", file),
		);
		const again = await expectOk<Added>(
			await add(cwd, String(issue), "--body-file", file),
		);
		expect(again).toMatchObject({ changed: false, id: first.id });
		expect(await readComments(server, repo, issue)).toEqual([
			expect.objectContaining({ body: "Line one  \r\nLine two\r\n\r\n" }),
		]);
		// Other line endings are other bytes: a new comment, not a retry.
		await Bun.write(file, "Line one  \nLine two\n\n");
		const other = await expectOk<Added>(
			await add(cwd, String(issue), "--body-file", file),
		);
		expect(other.changed).toBe(true);
	});

	test("the same body posts again after another user commented", async () => {
		const { cwd, file, issue } = await setup("LGTM");
		await expectOk(await add(cwd, String(issue), "--body-file", file));
		const bob = await createUser(server);
		await addComment(server, repo, issue, "One more change, please.", bob);
		const again = await expectOk<Added>(
			await add(cwd, String(issue), "--body-file", file),
		);
		expect(again.changed).toBe(true);
		expect(await readComments(server, repo, issue)).toHaveLength(3);
	});

	test("--dry-run writes nothing and gives the exact apply command", async () => {
		const { cwd, file, issue } = await setup("Plan text");
		const result = await add(
			cwd,
			String(issue),
			"--body-file",
			file,
			"--dry-run",
		);
		const plan = await expectOk<DryRun>(result);

		expect(plan).toEqual({
			dry_run: true,
			changed: true,
			issue,
			url: `${server.url}/${repo.owner}/${repo.name}/issues/${issue}`,
			body_chars: 9,
			apply: `fgj write comment add ${issue} --body-file ${file}`,
			as: "env",
		});
		expect(onlyGets(result)).toBe(true);
		expect(await readComments(server, repo, issue)).toHaveLength(0);

		await expectOk(await runFgj(server, argvOf(plan.apply), cwd));
		expect(await readComments(server, repo, issue)).toHaveLength(1);
	});

	test("a body path with spaces and a quoted ~ works and stays runnable", async () => {
		const { cwd, issue } = await setup("unused");
		// runFgj sets HOME to cwd, so ~/ is the work dir.
		await Bun.write(join(cwd, "my notes.md"), "From the home dir");
		const plan = await expectOk<DryRun>(
			await add(
				cwd,
				String(issue),
				"--body-file",
				"~/my notes.md",
				"--dry-run",
			),
		);
		expect(plan.apply).toBe(
			`fgj write comment add ${issue} --body-file '~/my notes.md'`,
		);
	});

	test("apply stays runnable for a body-file path that starts with a dash", async () => {
		const { cwd, issue } = await setup("unused");
		await Bun.write(join(cwd, "-dash.md"), "Dash path");
		const plan = await expectOk<DryRun>(
			await add(cwd, String(issue), "--body-file=-dash.md", "--dry-run"),
		);
		expect(plan.apply).toBe(
			`fgj write comment add ${issue} --body-file=-dash.md`,
		);
		await expectOk(await runFgj(server, argvOf(plan.apply), cwd));
		expect(await readComments(server, repo, issue)).toHaveLength(1);
	});

	test("bad body input fails locally with a hint and sends no request", async () => {
		const { cwd, file, issue } = await setup("x");
		const empty = join(cwd, "empty.md");
		await Bun.write(empty, " \n");
		const cases: [string[], RegExp][] = [
			[[String(issue)], /--body-file PATH/],
			[[String(issue), "--body", "hi"], /from a file.*--body-file PATH/],
			[[String(issue), "--body-file", join(cwd, "nope.md")], /Cannot read/],
			[[String(issue), "--body-file", empty], /empty/],
			[["--body-file", file], /Missing the issue number/],
		];
		for (const [args, message] of cases) {
			const result = await add(cwd, ...args);
			const err = await expectError(result, "usage", 2);
			expect(err.message).toMatch(message);
			expect(err.hint).toBe("fgj help comment add");
			expect(httpCalls(result)).toEqual([]);
		}
	});

	test("read comment add is a risk mismatch: exit 6 and no request", async () => {
		const { cwd, file, issue } = await setup("x");
		const result = await runFgj(
			server,
			["read", "comment", "add", String(issue), "--body-file", file],
			cwd,
		);
		const err = await expectError(result, "risk_mismatch", 6);
		expect(err.hint).toBe(`fgj write comment add ${issue} --body-file ${file}`);
		expect(httpCalls(result)).toEqual([]);
		expect(await readComments(server, repo, issue)).toHaveLength(0);

		const reverse = await runFgj(
			server,
			["write", "comment", "list", String(issue)],
			cwd,
		);
		expect((await expectError(reverse, "risk_mismatch", 6)).hint).toBe(
			`fgj read comment list ${issue}`,
		);
	});

	test("the read token cannot write, and fgj writes with the write token", async () => {
		const { cwd, file, issue } = await setup("x");
		const direct = await fetch(
			`${server.url}/api/v1/repos/${repo.owner}/${repo.name}/issues/${issue}/comments`,
			{
				method: "POST",
				headers: {
					authorization: `token ${server.readToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ body: "should fail" }),
			},
		);
		expect(direct.status).toBe(403);

		// Read token first: a prior post would make this a no-op repeat.
		const argv = [
			"write",
			"comment",
			"add",
			String(issue),
			"--body-file",
			file,
		];
		const asRead = await runFgj(server, argv, cwd, {
			FGJ_WRITE_TOKEN: server.readToken,
		});
		const err = await expectError(asRead, "auth", 3);
		expect(err.message).toContain("HTTP 403");
		expect(err.message).not.toContain("refused the token");
		expect(asRead.stderr + asRead.trace).not.toContain(server.readToken);
		expect(await readComments(server, repo, issue)).toHaveLength(0);

		const asWrite = await runFgj(server, argv, cwd);
		await expectOk(asWrite);
		expect(asWrite.trace).toContain('"ev":"token","kind":"write"');
		expect(await readComments(server, repo, issue)).toHaveLength(1);
	});

	test("a body that holds a known token is refused and never sent", async () => {
		const { cwd, file, issue } = await setup("x");
		// The body file holds the write token, as the token store would.
		await Bun.write(file, `leaked: ${server.writeToken}`);
		const result = await add(cwd, String(issue), "--body-file", file);
		const err = await expectError(result, "usage", 2);
		expect(err.message).toContain("holds a stored or env token");
		expect(httpCalls(result).some((c) => c.startsWith("POST"))).toBe(false);
		expect(result.stderr + result.trace).not.toContain(server.writeToken);
		expect(await readComments(server, repo, issue)).toHaveLength(0);
	});

	test("a dry run of a body that holds a token predicts the refusal", async () => {
		const { cwd, file, issue } = await setup("x");
		await Bun.write(file, `leaked: ${server.writeToken}`);
		const result = await add(
			cwd,
			String(issue),
			"--body-file",
			file,
			"--dry-run",
		);
		expect((await expectError(result, "usage", 2)).message).toContain(
			"holds a stored or env token",
		);
	});

	test("when that body is already the latest comment, a dry run and a run agree", async () => {
		const { cwd, file, issue } = await setup("x");
		const body = `leaked: ${server.writeToken}`;
		await Bun.write(file, body);
		await addComment(server, repo, issue, body);
		const args = [String(issue), "--body-file", file];
		const plan = await expectOk<{ changed: boolean }>(
			await add(cwd, ...args, "--dry-run"),
		);
		const run = await expectOk<{ changed: boolean }>(await add(cwd, ...args));
		expect([plan.changed, run.changed]).toEqual([false, false]);
		expect(await readComments(server, repo, issue)).toHaveLength(1);
	});

	test("no write token is an auth error before any request", async () => {
		const { cwd, file, issue } = await setup("x");
		const result = await runFgj(
			server,
			["write", "comment", "add", String(issue), "--body-file", file],
			cwd,
			{ FGJ_WRITE_TOKEN: "" },
		);
		const err = await expectError(result, "auth", 3);
		expect(err.message).toContain("has no write token");
		expect(httpCalls(result)).toEqual([]);
	});
});

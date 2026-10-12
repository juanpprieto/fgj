import { beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { saveProfile, setDefault } from "../../src/auth/store.ts";
import {
	createIssue,
	createRepo,
	createUser,
	expectError,
	expectOk,
	type FixtureRepo,
	httpCalls,
	type Login,
	loadServer,
	makeWorkDir,
	mintToken,
	readComments,
	runFgj,
	type TestServer,
} from "../support/forgejo.ts";

const READ = ["read:issue", "read:repository", "read:user"];
const WRITE = ["write:issue", "write:repository", "read:user"];
/** No env tokens: identity must come from the profiles. */
const NO_ENV = { FGJ_URL: "", FGJ_READ_TOKEN: "", FGJ_WRITE_TOKEN: "" };

describe("identity profiles", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let bob: Login;
	let cwd: string;
	let body: string;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		bob = await createUser(server);
		cwd = await makeWorkDir(server, repo);
		body = join(cwd, "c.md");
		const env = { HOME: cwd };
		await saveProfile(env, "dm", {
			host: server.url,
			user: server.username,
			read: await mintToken(server, server, READ),
			write: await mintToken(server, server, WRITE),
		});
		await saveProfile(env, "qa", {
			host: server.url,
			user: bob.username,
			read: await mintToken(server, bob, READ),
			write: await mintToken(server, bob, WRITE),
		});
	}, 60_000);

	const fgj = (args: string[], env: Record<string, string> = {}) =>
		runFgj(server, args, cwd, { ...NO_ENV, ...env });

	test("two profiles and no selection fail closed before any request", async () => {
		const issue = await createIssue(server, repo, "No guessing");
		const r = await fgj(["read", "comment", "list", String(issue)]);
		const err = await expectError(r, "auth", 3);
		expect(err.message).toContain("2 profiles");
		expect(err.message).toContain("dm, qa");
		expect(httpCalls(r)).toEqual([]);
	});

	test("two profiles and no default name the human fix, not --as", async () => {
		await Bun.write(body, "must not post");
		const r = await fgj(["write", "comment", "add", "1", "--body-file", body]);
		const err = await expectError(r, "auth", 3);
		expect(err.message).toContain("no profile is the default");
		expect(err.message).not.toContain("--as");
		expect(err.hint).toBe("fgj auth status");
		expect(httpCalls(r)).toEqual([]);
	});

	test("--as picks the account, and the output names it", async () => {
		const issue = await createIssue(server, repo, "QA note");
		await Bun.write(body, "QA: checked.");
		const out = await expectOk<{ as: string; id: number }>(
			await fgj([
				"write",
				"comment",
				"add",
				String(issue),
				"--body-file",
				body,
				"--as",
				"qa",
			]),
		);
		expect(out.as).toBe("qa");
		const [comment] = await readComments(server, repo, issue);
		expect(comment?.author).toBe(bob.username);
	});

	test("FGJ_PROFILE binds the account, and a different --as is refused", async () => {
		const issue = await createIssue(server, repo, "DM note");
		await Bun.write(body, "DM: approved.");
		const bound = { FGJ_PROFILE: "dm" };
		const ok = await expectOk<{ as: string }>(
			await fgj(
				["write", "comment", "add", String(issue), "--body-file", body],
				bound,
			),
		);
		expect(ok.as).toBe("dm");
		expect((await readComments(server, repo, issue))[0]?.author).toBe(
			server.username,
		);

		const swap = await fgj(
			[
				"write",
				"comment",
				"add",
				String(issue),
				"--body-file",
				body,
				"--as",
				"qa",
			],
			bound,
		);
		const err = await expectError(swap, "identity_mismatch", 7);
		expect(err.message).toContain("FGJ_PROFILE is dm");
		expect(httpCalls(swap)).toEqual([]);
		expect(await readComments(server, repo, issue)).toHaveLength(1);
		// An attempted switch is the most useful audit line of all.
		expect((await auditLines()).at(-1)).toMatchObject({
			as: "dm",
			attempted: "qa",
			error: "identity_mismatch",
		});
	});

	test("next and apply repeat --as only when --as chose the account", async () => {
		const issue = await createIssue(server, repo, "Paging");
		await Bun.write(body, "one");
		await fgj([
			"write",
			"comment",
			"add",
			String(issue),
			"--body-file",
			body,
			"--as",
			"qa",
		]);
		await Bun.write(body, "two");
		await fgj([
			"write",
			"comment",
			"add",
			String(issue),
			"--body-file",
			body,
			"--as",
			"dm",
		]);

		const byFlag = await expectOk<{ next: string }>(
			await fgj([
				"read",
				"comment",
				"list",
				String(issue),
				"--limit",
				"1",
				"--as",
				"qa",
			]),
		);
		expect(byFlag.next).toBe(
			`fgj read comment list ${issue} --limit 1 --offset 1 --as qa`,
		);
		const byEnv = await expectOk<{ next: string }>(
			await fgj(["read", "comment", "list", String(issue), "--limit", "1"], {
				FGJ_PROFILE: "qa",
			}),
		);
		expect(byEnv.next).toBe(
			`fgj read comment list ${issue} --limit 1 --offset 1`,
		);

		await Bun.write(body, "three");
		const plan = await expectOk<{ apply: string }>(
			await fgj([
				"write",
				"comment",
				"add",
				String(issue),
				"--body-file",
				body,
				"--dry-run",
				"--as",
				"qa",
			]),
		);
		expect(plan.apply).toBe(
			`fgj write comment add ${issue} --body-file ${body} --as qa`,
		);
	});

	test("an unknown profile and an error both name the identity problem", async () => {
		const unknown = await fgj(["read", "comment", "list", "1", "--as", "ops"]);
		expect((await expectError(unknown, "auth", 3)).message).toContain(
			'No profile "ops". Profiles: dm, qa',
		);
		const missing = await fgj([
			"read",
			"comment",
			"list",
			"99999",
			"--as",
			"qa",
		]);
		const err = await expectError(missing, "not_found", 4);
		expect(JSON.parse(missing.stderr).error.as).toBe("qa");
		expect(err.code).toBe("not_found");
	});

	test("every write goes to a 0600 audit log with no token; reads do not", async () => {
		const issue = await createIssue(server, repo, "Audit");
		await Bun.write(body, "audited");
		const before = await auditLines();
		await fgj(["read", "comment", "list", String(issue), "--as", "qa"]);
		await fgj(["write", "comment", "add", String(issue), "--body-file", body], {
			FGJ_PROFILE: "qa",
			CLAUDECODE: "1",
		});
		await fgj(["write", "comment", "add", "99999", "--body-file", body], {
			FGJ_PROFILE: "qa",
		});
		const lines = (await auditLines()).slice(before.length);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({
			as: "qa",
			user: bob.username,
			host: server.url,
			repo: `${repo.owner}/${repo.name}`,
			argv: ["write", "comment", "add", String(issue), "--body-file", body],
			result: { changed: true },
			harness: "claude",
		});
		expect(lines[1]).toMatchObject({ as: "qa", error: "not_found" });
		const file = join(cwd, ".local", "state", "fgj", "audit.jsonl");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const text = await Bun.file(file).text();
		expect(text).not.toMatch(/[0-9a-f]{40}/);
	});

	test("a refused --as for an unknown profile is audited too", async () => {
		const before = (await auditLines()).length;
		const r = await fgj(["read", "comment", "list", "1", "--as", "ghost"]);
		await expectError(r, "auth", 3);
		expect((await auditLines()).slice(before)).toEqual([
			expect.objectContaining({ attempted: "ghost", error: "auth" }),
		]);
	});

	test("the token store itself cannot be posted as a body", async () => {
		const issue = await createIssue(server, repo, "Store leak");
		const r = await fgj(
			[
				"write",
				"comment",
				"add",
				String(issue),
				"--body-file",
				join(cwd, ".config", "fgj", "hosts.json"),
			],
			{ FGJ_PROFILE: "dm" },
		);
		expect((await expectError(r, "usage", 2)).message).toContain(
			"holds a stored or env token",
		);
		expect(await readComments(server, repo, issue)).toHaveLength(0);
	});

	test("a read that the server refuses is not logged as a refused --as", async () => {
		// Its own work dir and store, so the shared profiles stay unchanged. The
		// profile matches the host, so --as is accepted; the server then refuses its
		// token (HTTP 401). That is an auth failure, not a switch.
		const own = await makeWorkDir(server, repo);
		await saveProfile({ HOME: own }, "stale", {
			host: server.url,
			user: "gone",
			read: "stale-read-token-00000000",
			write: "stale-write-token-0000000",
		});
		const r = await runFgj(
			server,
			["read", "comment", "list", "1", "--as", "stale"],
			own,
			NO_ENV,
		);
		expect((await expectError(r, "auth", 3)).message).toContain("HTTP 401");
		const audit = Bun.file(join(own, ".local", "state", "fgj", "audit.jsonl"));
		expect(await audit.exists()).toBe(false);
	});

	test("auth status shows which account a call here would use", async () => {
		const bound = await expectOk<{ active: unknown }>(
			await fgj(["auth", "status"], { FGJ_PROFILE: "qa" }),
		);
		expect(bound.active).toEqual({
			as: "qa",
			user: bob.username,
			host: server.url,
			source: "FGJ_PROFILE",
		});
		const open = await expectOk<{ active: { error: string } }>(
			await fgj(["auth", "status"]),
		);
		expect(open.active.error).toContain("2 profiles");
		expect(open.active).not.toHaveProperty("hint");
	});

	async function auditLines(): Promise<Record<string, unknown>[]> {
		const file = Bun.file(join(cwd, ".local", "state", "fgj", "audit.jsonl"));
		if (!(await file.exists())) return [];
		return (await file.text())
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	}
});

describe("the default profile", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let bob: Login;
	let body: string;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		bob = await createUser(server);
	}, 60_000);

	/** A work dir with its own store: `solo` for the server user, and maybe `qa`. */
	async function home(withQa: boolean): Promise<string> {
		const cwd = await makeWorkDir(server, repo);
		body = join(cwd, "c.md");
		await saveProfile({ HOME: cwd }, "solo", {
			host: server.url,
			user: server.username,
			read: await mintToken(server, server, READ),
			write: await mintToken(server, server, WRITE),
		});
		if (withQa) {
			await saveProfile({ HOME: cwd }, "qa", {
				host: server.url,
				user: bob.username,
				read: await mintToken(server, bob, READ),
				write: await mintToken(server, bob, WRITE),
			});
		}
		return cwd;
	}

	test("one profile and no default: reads and writes fail closed before any request", async () => {
		const cwd = await home(false);
		const issue = await createIssue(server, repo, "No silent default");
		await Bun.write(body, "must not post");
		for (const argv of [
			["read", "comment", "list", String(issue)],
			["write", "comment", "add", String(issue), "--body-file", body],
		]) {
			// The env tokens name this host too; they must not stand in for a default.
			const r = await runFgj(server, argv, cwd);
			const err = await expectError(r, "auth", 3);
			expect(err.hint).toBe("fgj auth default solo");
			expect(err.message).not.toContain("--as");
			expect(httpCalls(r)).toEqual([]);
		}
		expect(await readComments(server, repo, issue)).toHaveLength(0);
	});

	test("one profile marked as the default: unbound reads and writes use it", async () => {
		const cwd = await home(false);
		await setDefault({ HOME: cwd }, "solo");
		const issue = await createIssue(server, repo, "Default one");
		await Bun.write(body, "by default");
		const out = await expectOk<{ as: string }>(
			await runFgj(
				server,
				["write", "comment", "add", String(issue), "--body-file", body],
				cwd,
				NO_ENV,
			),
		);
		expect(out.as).toBe("solo");
		const read = await expectOk<{ as: string; total: number }>(
			await runFgj(
				server,
				["read", "comment", "list", String(issue)],
				cwd,
				NO_ENV,
			),
		);
		expect(read).toMatchObject({ as: "solo", total: 1 });
		const audit = await Bun.file(
			join(cwd, ".local", "state", "fgj", "audit.jsonl"),
		).text();
		expect(JSON.parse(audit.trim().split("\n").at(-1) ?? "")).toMatchObject({
			as: "solo",
			user: server.username,
		});
	});

	test("one profile and no default: a binding still works for reads and writes", async () => {
		const cwd = await home(false);
		const issue = await createIssue(server, repo, "Bound, no default");
		await Bun.write(body, "bound");
		const byEnv = await expectOk<{ as: string }>(
			await runFgj(
				server,
				["write", "comment", "add", String(issue), "--body-file", body],
				cwd,
				{ ...NO_ENV, FGJ_PROFILE: "solo" },
			),
		);
		expect(byEnv.as).toBe("solo");
		const byFlag = await expectOk<{ as: string; total: number }>(
			await runFgj(
				server,
				["read", "comment", "list", String(issue), "--as", "solo"],
				cwd,
				NO_ENV,
			),
		);
		expect(byFlag).toMatchObject({ as: "solo", total: 1 });
	});

	test("two profiles with a default: unbound uses it, and a binding wins", async () => {
		const cwd = await home(true);
		await setDefault({ HOME: cwd }, "qa");
		const issue = await createIssue(server, repo, "Default of two");
		await Bun.write(body, "unbound");
		const unbound = await expectOk<{ as: string }>(
			await runFgj(
				server,
				["write", "comment", "add", String(issue), "--body-file", body],
				cwd,
				NO_ENV,
			),
		);
		expect(unbound.as).toBe("qa");
		const read = await expectOk<{ as: string }>(
			await runFgj(
				server,
				["read", "comment", "list", String(issue)],
				cwd,
				NO_ENV,
			),
		);
		expect(read.as).toBe("qa");
		await Bun.write(body, "bound");
		const bound = await expectOk<{ as: string }>(
			await runFgj(
				server,
				["write", "comment", "add", String(issue), "--body-file", body],
				cwd,
				{ ...NO_ENV, FGJ_PROFILE: "solo" },
			),
		);
		expect(bound.as).toBe("solo");
		const authors = (await readComments(server, repo, issue)).map(
			(c) => c.author,
		);
		expect(authors.sort()).toEqual([bob.username, server.username].sort());
	});
});

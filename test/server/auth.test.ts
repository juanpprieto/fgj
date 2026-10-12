import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { hostsFile, saveProfile } from "../../src/auth/store.ts";
import { main } from "../../src/core/dispatch.ts";
import {
	addComment,
	createIssue,
	createRepo,
	createUser,
	expectOk,
	httpCalls,
	loadServer,
	makeWorkDir,
	mintToken,
	runFgj,
	type TestServer,
} from "../support/forgejo.ts";
import { cleanEnv, tempDir } from "../support/tmp.ts";

const READ = ["read:issue", "read:repository", "read:user"];
const WRITE = ["write:issue", "write:repository", "read:user"];

/**
 * Runs fgj in-process as a human at a terminal would: `answers` feed the
 * prompts in order. With `answers` undefined, fgj has no terminal.
 */
async function fgj(home: string, argv: string[], answers?: string[]) {
	let stdout = "";
	let stderr = "";
	const asked: string[] = [];
	const queue = [...(answers ?? [])];
	const code = await main(argv, {
		cwd: home,
		env: { HOME: home },
		stdout: (t) => {
			stdout += t;
		},
		stderr: (t) => {
			stderr += t;
		},
		...(answers
			? {
					prompt: async (question: string) => {
						asked.push(question);
						return queue.shift() ?? "";
					},
				}
			: {}),
	});
	return { code, stdout, stderr, asked };
}

describe("fgj auth", () => {
	let server: TestServer;
	let home: string;
	let readToken: string;
	let writeToken: string;

	beforeAll(async () => {
		server = await loadServer();
		readToken = await mintToken(server, server, READ);
		writeToken = await mintToken(server, server, WRITE);
	}, 60_000);

	const freshHome = () => tempDir("fgj-auth-");

	test("with no terminal it fails at once and never waits for input", async () => {
		home = freshHome();
		const r = await fgj(home, ["auth", server.url]);
		expect(r.code).toBe(2);
		const err = JSON.parse(r.stderr).error;
		expect(err.message).toMatch(/human.*terminal/);
		expect(err.hint).toBe("fgj auth status");
	});

	test("a server that is not Forgejo is refused before any token prompt", async () => {
		// A proxy block page: 403 with HTML, not Forgejo's JSON message.
		const other = Bun.serve({
			port: 0,
			fetch: () =>
				new Response("<h1>Forbidden</h1>", {
					status: 403,
					headers: { "content-type": "text/html" },
				}),
		});
		try {
			const r = await fgj(freshHome(), ["auth", other.url.origin], []);
			expect(r.code).toBe(1);
			expect(JSON.parse(r.stderr).error.message).toContain(
				"is not a reachable Forgejo server",
			);
			expect(r.asked).toEqual([]);
		} finally {
			other.stop(true);
		}
	});

	test("a sign-in-only host that refuses /user without a Forgejo error is not blamed on the token", async () => {
		// It passes the version check through the sign-in branch, like Forgejo with
		// REQUIRE_SIGNIN_VIEW. Its 401 has no swagger url, so it may not be Forgejo.
		const other = Bun.serve({
			port: 0,
			fetch: (req) =>
				new URL(req.url).pathname === "/api/v1/version"
					? Response.json({ message: "sign in" }, { status: 403 })
					: Response.json({ message: "unauthorized" }, { status: 401 }),
		});
		try {
			const r = await fgj(freshHome(), ["auth", other.url.origin], [readToken]);
			expect(r.code).toBe(1);
			const err = JSON.parse(r.stderr.trim().split("\n").at(-1) ?? "").error;
			expect(err.message).toContain("may not be Forgejo");
			expect(err.message).not.toContain("token is not valid");
			expect(r.asked).toHaveLength(1);
		} finally {
			other.stop(true);
		}
	});

	test("the prompt names the token page, the exact scopes, and what each token does", async () => {
		home = freshHome();
		const r = await fgj(
			home,
			["auth", server.url],
			[`  ${readToken}\n`, writeToken],
		);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain(`${server.url}/user/settings/applications`);
		expect(r.stderr).toContain("read:issue, read:repository, read:user");
		expect(r.stderr).toContain("write:issue, write:repository, read:user");
		// The Forgejo token page shows categories with Read / Read and write menus.
		expect(r.stderr).toContain("issue: Read, repository: Read, user: Read");
		expect(r.stderr).toContain(
			"issue: Read and write, repository: Read and write, user: Read",
		);
		expect(r.stderr).toContain("Every other category: No access");
		expect(r.stderr).toContain("It cannot change anything");
		expect(r.stderr).toMatch(/dedicated bot account/);
		expect(r.asked).toEqual([
			"Read token (input hidden): ",
			"Write token (input hidden): ",
			`Make ${server.username} the default for ${server.url}? Calls that select no profile will act as ${server.username}. [y/N] `,
		]);
		expect(JSON.parse(r.stdout)).toEqual({
			changed: true,
			profile: server.username,
			host: server.url,
			user: server.username,
			file: hostsFile({ HOME: home }),
		});
		expect(r.stdout + r.stderr).not.toContain(readToken);
		expect(r.stdout + r.stderr).not.toContain(writeToken);
		const file = hostsFile({ HOME: home });
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const saved = await Bun.file(file).json();
		// The pasted spaces and newline are gone.
		expect(saved.profiles[server.username]).toEqual({
			host: server.url,
			user: server.username,
			read: readToken,
			write: writeToken,
		});
	});

	test("the stored tokens drive real calls with no env tokens", async () => {
		const repo = await createRepo(server);
		const issue = await createIssue(server, repo, "Stored token");
		await addComment(server, repo, issue, "hello");
		const cwd = await makeWorkDir(server, repo);
		expect(
			(await fgj(cwd, ["auth", server.url], [readToken, writeToken, "y"])).code,
		).toBe(0);
		const result = await runFgj(
			server,
			["read", "comment", "list", String(issue)],
			cwd,
			{ FGJ_URL: "", FGJ_READ_TOKEN: "", FGJ_WRITE_TOKEN: "" },
		);
		expect((await expectOk<{ total: number }>(result)).total).toBe(1);
		expect(result.trace).toContain(
			`"ev":"token","kind":"read","as":"${server.username}","source":"file"`,
		);
		expect(result.trace).toContain('"hostSource":"origin"');
	});

	test("a read token that can write is refused, and nothing is saved", async () => {
		home = freshHome();
		const all = await mintToken(server, server, ["all"]);
		const r = await fgj(home, ["auth", server.url], [all, all, all]);
		expect(r.code).toBe(3);
		const err = JSON.parse(r.stderr.trim().split("\n").at(-1) ?? "").error;
		expect(err.message).toMatch(/read token can write/);
		expect(r.asked).toHaveLength(3);
		expect(await Bun.file(hostsFile({ HOME: home })).exists()).toBe(false);
		expect(r.stderr).not.toContain(all);
	});

	test("a read token with any other write scope is refused and names it", async () => {
		for (const scope of [
			"write:user",
			"write:organization",
			"write:package",
			"write:notification",
			"write:admin",
		]) {
			home = freshHome();
			const token = await mintToken(server, server, [...READ, scope]);
			const r = await fgj(home, ["auth", server.url], [token, token, token]);
			const err = JSON.parse(r.stderr.trim().split("\n").at(-1) ?? "").error;
			expect({ scope, code: r.code, message: err.message }).toMatchObject({
				scope,
				code: 3,
				message: expect.stringContaining(`it has ${scope} or all`),
			});
			expect(await Bun.file(hostsFile({ HOME: home })).exists()).toBe(false);
		}
	}, 60_000);

	test("each missing scope is named", async () => {
		home = freshHome();
		const userOnly = await mintToken(server, server, ["read:user"]);
		const noRead = await fgj(
			home,
			["auth", server.url],
			[userOnly, userOnly, userOnly],
		);
		expect(noRead.stderr).toContain("lacks read:issue");

		const writeAsRead = await fgj(
			home,
			["auth", server.url],
			[readToken, readToken, readToken, readToken],
		);
		expect(writeAsRead.code).toBe(3);
		expect(writeAsRead.stderr).toContain("lacks write:issue");
	});

	test("a retry after a bad paste works without starting over", async () => {
		home = freshHome();
		const r = await fgj(
			home,
			["auth", server.url],
			["not-a-real-token-000000", readToken, writeToken],
		);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("HTTP 401");
		expect(r.stderr).not.toContain("not-a-real-token-000000");
	});

	test("tokens from two different users are refused", async () => {
		home = freshHome();
		const bob = await createUser(server);
		const bobWrite = await mintToken(server, bob, WRITE);
		const r = await fgj(
			home,
			["auth", server.url],
			[readToken, bobWrite, bobWrite, bobWrite],
		);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain(`belongs to ${bob.username}`);
	});

	test("a host that is not Forgejo fails before any prompt", async () => {
		home = freshHome();
		for (const url of ["http://127.0.0.1:1", `${server.url}/explore`]) {
			const r = await fgj(home, ["auth", url], [readToken, writeToken]);
			expect(r.code).not.toBe(0);
			expect(r.asked).toEqual([]);
		}
		const bad = await fgj(home, ["auth", "git.example.com"], []);
		expect(JSON.parse(bad.stderr).error.message).toContain("http(s) URL");
	});

	test("status shows hosts, users, and a live check, with no tokens", async () => {
		home = freshHome();
		await fgj(home, ["auth", server.url], [readToken, writeToken, "y"]);
		const r = await fgj(home, ["auth", "status"]);
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({
			file: hostsFile({ HOME: home }),
			profiles: [
				{
					profile: server.username,
					host: server.url,
					user: server.username,
					read: "ok",
					write: "ok",
					web: "none",
					default: true,
				},
			],
			active: {
				as: server.username,
				user: server.username,
				host: server.url,
				source: "the default for the host",
			},
		});
		expect(r.stdout).not.toContain(readToken);

		chmodSync(hostsFile({ HOME: home }), 0o644);
		const open = await fgj(home, ["auth", "status"]);
		expect(open.code).toBe(3);
		expect(JSON.parse(open.stderr).error.message).toContain("chmod 600");
	});

	test("auth asks for the default, and only y marks it", async () => {
		home = freshHome();
		const no = await fgj(
			home,
			["auth", "--profile", "dm", server.url],
			[readToken, writeToken, "n"],
		);
		expect(JSON.parse(no.stdout)).not.toHaveProperty("default");
		expect((await Bun.file(hostsFile({ HOME: home })).json()).defaults).toEqual(
			{},
		);

		const yes = await fgj(
			home,
			["auth", "--profile", "qa", server.url],
			[readToken, writeToken, "y"],
		);
		expect(JSON.parse(yes.stdout)).toMatchObject({
			changed: true,
			profile: "qa",
			default: true,
		});

		// The question names the default that a yes replaces.
		const swap = await fgj(
			home,
			["auth", "--profile", "dm", server.url],
			[readToken, writeToken, "n"],
		);
		expect(swap.asked.at(-1)).toBe(
			`Make dm the default for ${server.url}, instead of qa? Calls that select no profile will act as ${server.username}. [y/N] `,
		);

		// A login of the profile that is already the default does not ask again.
		const same = await fgj(
			home,
			["auth", "--profile", "qa", server.url],
			[readToken, writeToken],
		);
		expect(same.asked).toHaveLength(2);
		expect(JSON.parse(same.stdout)).toMatchObject({ default: true });
	});

	test("a flag before the auth subcommand is refused, so a gate sees one fixed shape", async () => {
		home = freshHome();
		await fgj(
			home,
			["auth", "--profile", "dm", server.url],
			[readToken, writeToken, "n"],
		);
		for (const argv of [
			["auth", "--json", "default", "dm"],
			["auth", "--json", "remove", "dm"],
		]) {
			const r = await fgj(home, argv, ["y"]);
			expect({ argv, code: r.code, asked: r.asked }).toEqual({
				argv,
				code: 2,
				asked: [],
			});
			expect(JSON.parse(r.stderr).error.message).toContain(
				"Put --json after the subcommand",
			);
		}
		const saved = await Bun.file(hostsFile({ HOME: home })).json();
		expect(saved.defaults).toEqual({});
		expect(Object.keys(saved.profiles)).toEqual(["dm"]);
	});

	test("replacing the default profile with another account says so in the question", async () => {
		home = freshHome();
		await fgj(
			home,
			["auth", "--profile", "dm", server.url],
			[readToken, writeToken, "y"],
		);
		const bob = await createUser(server);
		const r = await fgj(
			home,
			["auth", "--profile", "dm", server.url],
			[
				await mintToken(server, bob, READ),
				await mintToken(server, bob, WRITE),
				"n",
			],
		);
		expect(r.asked.at(-1)).toBe(
			`Replace profile dm (${server.username} on ${server.url}) with ${bob.username} on ${server.url}? It is the default for ${server.url}: calls that select no profile will act as ${bob.username}. [y/N] `,
		);
	}, 60_000);

	test("a sign-in-only host whose 403 is not a Forgejo account text is not blamed on the account", async () => {
		// A gateway can answer every path with 403 and a JSON message. Its version
		// check passes the sign-in branch, so it may not be Forgejo; fgj must not
		// ask for more tokens to send to it.
		const other = Bun.serve({
			port: 0,
			fetch: () => Response.json({ message: "Forbidden" }, { status: 403 }),
		});
		try {
			const r = await fgj(freshHome(), ["auth", other.url.origin], [readToken]);
			expect(r.code).toBe(1);
			const err = JSON.parse(r.stderr.trim().split("\n").at(-1) ?? "").error;
			expect(err.message).toContain("may not be Forgejo");
			expect(r.asked).toHaveLength(1);
		} finally {
			other.stop(true);
		}
	});

	test("a server reason loses its control characters before it reaches the terminal", async () => {
		const other = Bun.serve({
			port: 0,
			fetch: (req) =>
				new URL(req.url).pathname === "/api/v1/version"
					? Response.json({ version: "16.0.5" })
					: Response.json(
							{
								message: `\u001b[2J\u001b[31m\u009b2J\u202eblocked${"x".repeat(400)}`,
							},
							{ status: 403 },
						),
		});
		try {
			const r = await fgj(
				freshHome(),
				["auth", other.url.origin],
				[readToken, readToken, readToken],
			);
			expect(r.code).toBe(3);
			expect(r.stderr).not.toContain("\u001b");
			expect(r.stderr).not.toContain("\u009b");
			expect(r.stderr).not.toContain("\u202e");
			expect(r.stderr).toContain("[2J[31m2Jblocked");
			expect(r.stderr).not.toContain("x".repeat(250));
		} finally {
			other.stop(true);
		}
	});

	test("a disabled account is reported with the server's reason, not as a host problem", async () => {
		const carol = await createUser(server);
		const token = await mintToken(server, carol, READ);
		const res = await fetch(
			`${server.url}/api/v1/admin/users/${carol.username}`,
			{
				method: "PATCH",
				headers: {
					authorization: `Basic ${btoa(`${server.username}:${server.password}`)}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					login_name: carol.username,
					source_id: 0,
					prohibit_login: true,
				}),
			},
		);
		expect(res.status).toBe(200);
		const r = await fgj(
			freshHome(),
			["auth", server.url],
			[token, token, token],
		);
		expect(r.code).toBe(3);
		const err = JSON.parse(r.stderr.trim().split("\n").at(-1) ?? "").error;
		expect(err.message).toContain("HTTP 403");
		expect(err.message).toContain("prohibited from signing in");
		expect(err.message).not.toContain("may not be Forgejo");
	}, 60_000);

	test("auth default changes the default, and only a human can run it", async () => {
		home = freshHome();
		await fgj(
			home,
			["auth", "--profile", "dm", server.url],
			[readToken, writeToken, "n"],
		);
		await fgj(
			home,
			["auth", "--profile", "qa", server.url],
			[readToken, writeToken, "n"],
		);

		const agent = await fgj(home, ["auth", "default", "dm"]);
		expect(agent.code).toBe(2);
		expect(JSON.parse(agent.stderr).error.message).toMatch(/human/);

		const missing = await fgj(home, ["auth", "default"], []);
		expect(missing.code).toBe(2);
		expect(JSON.parse(missing.stderr).error.hint).toBe("fgj auth status");

		const ghost = await fgj(home, ["auth", "default", "ghost"], ["y"]);
		expect(ghost.code).toBe(3);
		expect(JSON.parse(ghost.stderr).error.message).toContain(
			'No profile "ghost". Profiles: dm, qa',
		);

		const no = await fgj(home, ["auth", "default", "dm"], ["n"]);
		expect(no.asked).toEqual([
			`Make dm (${server.username}) the default for ${server.url}? Calls that select no profile will act as ${server.username}. [y/N] `,
		]);
		expect(JSON.parse(no.stdout)).toEqual({
			changed: false,
			profile: "dm",
			declined: true,
		});

		const yes = await fgj(home, ["auth", "default", "dm"], ["y"]);
		expect(JSON.parse(yes.stdout)).toEqual({
			changed: true,
			profile: "dm",
			host: server.url,
		});
		const again = await fgj(home, ["auth", "default", "dm"], []);
		expect(again.asked).toEqual([]);
		expect(JSON.parse(again.stdout)).toEqual({
			changed: false,
			profile: "dm",
			host: server.url,
		});
		const saved = await Bun.file(hostsFile({ HOME: home })).json();
		expect(saved.defaults).toEqual({ [server.url]: "dm" });
	});

	test("status with no default says why and names the fix", async () => {
		home = freshHome();
		await fgj(
			home,
			["auth", "--profile", "dm", server.url],
			[readToken, writeToken, "n"],
		);
		const r = await fgj(home, ["auth", "status"]);
		const out = JSON.parse(r.stdout);
		expect(out.profiles[0]).not.toHaveProperty("default");
		expect(out.active).toEqual({
			error: expect.stringContaining("no profile is the default"),
			hint: "fgj auth default dm",
		});
	});

	test("auth -h shows the auth help, and remove of a prototype name asks nothing", async () => {
		home = freshHome();
		const help = await fgj(home, ["auth", "-h"]);
		expect(help.code).toBe(0);
		const text = JSON.parse(help.stdout);
		expect(text.commands).toHaveProperty("fgj auth status");
		expect(text.flags).toContain("after the subcommand");
		const r = await fgj(home, ["auth", "remove", "constructor"], ["y"]);
		expect(r.asked).toEqual([]);
		expect(JSON.parse(r.stdout)).toEqual({
			changed: false,
			profile: "constructor",
		});
	});

	test("remove forgets one profile, and only a human can run it", async () => {
		home = freshHome();
		await fgj(home, ["auth", server.url], [readToken, writeToken]);
		const agent = await fgj(home, ["auth", "remove", server.username]);
		expect(agent.code).toBe(2);
		expect(JSON.parse(agent.stderr).error.message).toMatch(/human/);

		const no = await fgj(home, ["auth", "remove", server.username], ["n"]);
		expect(no.asked[0]).toMatch(/Remove profile .* \[y\/N\] $/);
		expect(JSON.parse(no.stdout)).toMatchObject({
			changed: false,
			declined: true,
		});

		const r = await fgj(home, ["auth", "remove", server.username], ["y"]);
		expect(JSON.parse(r.stdout)).toEqual({
			changed: true,
			profile: server.username,
		});
		const again = await fgj(home, ["auth", "remove", server.username], ["y"]);
		expect(JSON.parse(again.stdout).changed).toBe(false);
	});

	test("auth asks before it replaces a profile with another account or host", async () => {
		home = freshHome();
		await fgj(
			home,
			["auth", "--profile", "dm", server.url],
			[readToken, writeToken],
		);
		const bob = await createUser(server);
		const bobRead = await mintToken(server, bob, READ);
		const bobWrite = await mintToken(server, bob, WRITE);
		const keep = await fgj(
			home,
			["auth", "--profile", "dm", server.url],
			[bobRead, bobWrite, "n"],
		);
		expect(keep.asked.at(-1)).toMatch(/Replace profile dm .* \[y\/N\] $/);
		expect(JSON.parse(keep.stdout)).toMatchObject({ changed: false });
		const saved = await Bun.file(hostsFile({ HOME: home })).json();
		expect(saved.profiles.dm.user).toBe(server.username);
	}, 60_000);

	test("a real terminal: no echo, Ctrl-D answers no, and Ctrl-C exits 130 with nothing saved", async () => {
		const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");
		/**
		 * Runs fgj auth in a pseudo-terminal through `script`, and types each
		 * answer only after its prompt appears, as a human does.
		 */
		async function terminal(
			ptyHome: string,
			steps: [string, string][],
			resultOn?: string,
		) {
			// Bun gives the child a socket for stdin, and macOS `script` rejects a
			// socket; `cat |` hands `script` a real pipe instead. Linux `script`
			// takes the command as one string after -c, and -e returns its exit code.
			const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
			const inner = `bun ${quote(cli)} auth ${quote(server.url)}`;
			const scriptCmd =
				process.platform === "linux"
					? `cat | script -q -e -c ${quote(inner)} /dev/null`
					: `cat | script -q /dev/null ${inner}`;
			const proc = Bun.spawn(["sh", "-c", scriptCmd], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: cleanEnv(ptyHome),
			});
			let screen = "";
			const reader = proc.stdout.getReader();
			const pump = (async () => {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) return;
					screen += new TextDecoder().decode(value);
				}
			})();
			for (const [waitFor, type] of steps) {
				const deadline = Date.now() + 15_000;
				while (!screen.includes(waitFor)) {
					if (Date.now() > deadline) {
						proc.kill();
						throw new Error(`No "${waitFor}" on screen:\n${screen}`);
					}
					await Bun.sleep(20);
				}
				proc.stdin.write(type);
				await proc.stdin.flush();
			}
			// Wait for the result line before stdin closes. On close, `script` types its
			// own Ctrl-D, which can reach fgj before the last keystrokes. Close stdin
			// at the end, or `cat` keeps the pipeline open.
			if (resultOn) {
				const deadline = Date.now() + 15_000;
				while (!screen.includes(resultOn) && Date.now() < deadline) {
					await Bun.sleep(20);
				}
			}
			proc.stdin.end();
			const code = await Promise.race([
				proc.exited,
				Bun.sleep(15_000).then(() => {
					proc.kill();
					return -1;
				}),
			]);
			await pump;
			return { screen, code };
		}

		const okHome = freshHome();
		const ok = await terminal(
			okHome,
			[
				["Read token (input hidden): ", `${readToken}\r`],
				["Write token (input hidden): ", `${writeToken}\r`],
				["[y/N] ", "n\r"],
			],
			'"changed"',
		);
		expect(ok.code).toBe(0);
		expect(ok.screen).toContain('"changed":true');
		// No echo: the typed tokens never reach the screen.
		expect(ok.screen).not.toContain(readToken);
		expect(ok.screen).not.toContain(writeToken);
		expect(await Bun.file(hostsFile({ HOME: okHome })).exists()).toBe(true);

		// With echo on, Ctrl-D closes stdin. The question reads it as no, and fgj
		// still prints its result.
		const eofHome = freshHome();
		const eof = await terminal(
			eofHome,
			[
				["Read token (input hidden): ", `${readToken}\r`],
				["Write token (input hidden): ", `${writeToken}\r`],
				["[y/N] ", "\u0004"],
			],
			'"changed"',
		);
		expect(eof.code).toBe(0);
		expect(eof.screen).toContain('"changed":true');
		expect(eof.screen).not.toContain('"default"');

		// After stdin ends, a later question reads as an empty answer. Here the
		// replace question gets "y" then end of input; the default question must not
		// leave fgj silent.
		const endHome = freshHome();
		await saveProfile({ HOME: endHome }, server.username, {
			host: "https://other.example",
			user: "someone",
			read: "r-other-000000000000",
			write: "w-other-000000000000",
		});
		const ended = await terminal(
			endHome,
			[
				["Read token (input hidden): ", `${readToken}\r`],
				["Write token (input hidden): ", `${writeToken}\r`],
				["Replace profile", "y\u0004\u0004"],
			],
			'"changed"',
		);
		expect(ended.code).toBe(0);
		expect(ended.screen).toContain('"changed":true');
		expect(ended.screen).not.toContain('"default"');

		const ctrlC = freshHome();
		const cancelled = await terminal(ctrlC, [
			["Read token (input hidden): ", "abc\u0003"],
		]);
		expect(cancelled.code).toBe(130);
		expect(cancelled.screen).not.toContain("abc");
		expect(await Bun.file(hostsFile({ HOME: ctrlC })).exists()).toBe(false);
	}, 60_000);

	test("no token appears in a trace of fgj auth", async () => {
		home = freshHome();
		const traceFile = join(home, "trace.jsonl");
		let out = "";
		await main(["auth", server.url], {
			cwd: home,
			env: { HOME: home, FGJ_TRACE: traceFile },
			stdout: (t) => {
				out += t;
			},
			stderr: () => {},
			prompt: async (q) => (q.startsWith("Read") ? readToken : writeToken),
		});
		const trace = await Bun.file(traceFile).text();
		expect(httpCalls({ trace }).length).toBeGreaterThan(4);
		expect(trace + out).not.toContain(readToken);
		expect(trace + out).not.toContain(writeToken);
	});
});

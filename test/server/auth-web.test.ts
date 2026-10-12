import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { saveProfile } from "../../src/auth/store.ts";
import { main } from "../../src/core/dispatch.ts";
import {
	createUser,
	enrollTotp,
	loadServer,
	type TestServer,
	totpCode,
	webProfile,
} from "../support/forgejo.ts";
import { tempDir } from "../support/tmp.ts";

/** Runs fgj in-process; `answers` feed the prompts in order, or no terminal. */
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

/** The JSON error: the last stderr line, after the sign-in text. */
const errorOf = (stderr: string) =>
	JSON.parse(stderr.trim().split("\n").at(-1) ?? "").error;

const hosts = (home: string) => join(home, ".config", "fgj", "hosts.json");

describe("fgj auth web", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await loadServer();
	});

	/** A home with one profile for the admin, with tokens and no web login. */
	const home = async () => {
		const dir = tempDir("fgj-web-");
		await saveProfile({ HOME: dir }, "t", {
			host: server.url,
			user: server.username,
			read: server.readToken,
			write: server.writeToken,
		});
		return dir;
	};

	test("with no terminal it fails at once and asks nothing", async () => {
		const dir = await home();
		const r = await fgj(dir, ["auth", "web", "--profile", "t"]);
		expect(r.code).toBe(2);
		const err = errorOf(r.stderr);
		expect(err.message).toMatch(/human.*terminal/);
		expect(err.hint).toBe("fgj auth status");
	});

	test("it keeps only the remember-me cookie, at 0600, and never the password", async () => {
		const dir = await home();
		const r = await fgj(
			dir,
			["auth", "web", "--profile", "t"],
			[server.password],
		);
		expect(r.code).toBe(0);
		expect(r.asked).toEqual([
			`Password for ${server.username} (input hidden): `,
		]);
		const out = JSON.parse(r.stdout);
		expect(out).toMatchObject({
			changed: true,
			profile: "t",
			user: server.username,
		});
		const days = (Date.parse(out.web_expires) - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(30);
		expect(days).toBeLessThan(32);
		const raw = readFileSync(hosts(dir), "utf8");
		expect(statSync(hosts(dir)).mode & 0o777).toBe(0o600);
		expect(raw).not.toContain(server.password);
		const web = JSON.parse(raw).profiles.t.web;
		expect(Object.keys(web).sort()).toEqual(["cookie", "expires", "value"]);
		expect(web.cookie).toBe("persistent");
		expect(r.stdout + r.stderr).not.toContain(web.value);
		expect(r.stdout + r.stderr).not.toContain(server.password);
	});

	test("a wrong password fails with auth and stores nothing", async () => {
		const dir = await home();
		const r = await fgj(
			dir,
			["auth", "web", "--profile", "t"],
			["wrong-password"],
		);
		expect(r.code).toBe(3);
		expect(errorOf(r.stderr).message).toContain("refused the password");
		expect(
			JSON.parse(readFileSync(hosts(dir), "utf8")).profiles.t.web,
		).toBeUndefined();
	});

	test("an account with TOTP needs the code at sign-in; a wrong code fails", async () => {
		const carol = await createUser(server);
		const secret = await enrollTotp(server, carol);
		const dir = tempDir("fgj-web-");
		const bad = await webProfile(server, dir, {
			login: carol,
			code: () => "000000",
		}).catch((e: Error) => e.message);
		expect(String(bad)).toContain("refused the TOTP code");
		const out = await webProfile(server, dir, {
			login: carol,
			code: () => totpCode(secret),
		});
		expect(out).toMatchObject({ changed: true, user: carol.username });
	}, 30_000);

	test("auth status shows the web login and its date, and none for a profile without one", async () => {
		const dir = await home();
		await saveProfile({ HOME: dir }, "other", {
			host: server.url,
			user: server.username,
			read: server.readToken,
			write: server.writeToken,
		});
		await fgj(dir, ["auth", "web", "--profile", "t"], [server.password]);
		const r = await fgj(dir, ["auth", "status"]);
		expect(r.code).toBe(0);
		const profiles = JSON.parse(r.stdout).profiles as Record<string, unknown>[];
		const t = profiles.find((p) => p.profile === "t");
		const other = profiles.find((p) => p.profile === "other");
		expect(t).toMatchObject({ web: "ok" });
		expect(typeof t?.web_expires).toBe("string");
		expect(other).toMatchObject({ web: "none" });
		expect(other?.web_expires).toBeUndefined();
	});

	test("with several profiles and no --profile, it fails and names them", async () => {
		const dir = await home();
		await saveProfile({ HOME: dir }, "other", {
			host: server.url,
			user: server.username,
			read: server.readToken,
			write: server.writeToken,
		});
		const r = await fgj(dir, ["auth", "web"], [server.password]);
		expect(r.code).toBe(2);
		expect(errorOf(r.stderr).message).toContain("t, other");
		expect(r.asked).toEqual([]);
		const x = await fgj(dir, ["auth", "web", "--profile", "t", "extra"], []);
		expect(x.code).toBe(2);
	});
});

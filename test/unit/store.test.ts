import { describe, expect, test } from "bun:test";
import { chmodSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
	hostsFile,
	readStore,
	removeProfile,
	saveProfile,
	saveWebLogin,
	setBoundOnly,
	setDefault,
} from "../../src/auth/store.ts";
import { tempDir } from "../support/tmp.ts";

const A = "https://a.example";
const B = "http://127.0.0.1:3917";
const entry = (host: string, user: string) => ({
	host,
	user,
	read: `read-token-${user}-0000`,
	write: `write-token-${user}-0000`,
});

function freshEnv(): Record<string, string | undefined> {
	return { HOME: tempDir("fgj-store-") };
}

describe("token store", () => {
	test("new tokens for the same account keep the web login; another account drops it", async () => {
		const env = freshEnv();
		const web = {
			cookie: "persistent",
			value: "web-cookie-value-0000",
			expires: "2027-01-01T00:00:00.000Z",
		};
		await saveProfile(env, "dm", entry(A, "dm-bot"));
		await saveWebLogin(env, "dm", web);
		await saveProfile(env, "dm", {
			...entry(A, "dm-bot"),
			read: "new-read-0000",
		});
		expect((await readStore(env)).profiles.dm?.web).toEqual(web);
		await saveProfile(env, "dm", entry(A, "other-bot"));
		expect((await readStore(env)).profiles.dm?.web).toBeUndefined();
		await expect(saveWebLogin(env, "nobody", web)).rejects.toThrow(
			/No profile "nobody"/,
		);
	});

	test("setBoundOnly marks a profile, new tokens for the same account keep the mark, and another account drops it", async () => {
		const env = freshEnv();
		await saveProfile(env, "qa", entry(A, "qa-bot"));
		expect(await setBoundOnly(env, "qa", true)).toBe(true);
		expect(await setBoundOnly(env, "qa", true)).toBe(false);
		expect((await readStore(env)).profiles.qa?.boundOnly).toBe(true);
		await saveProfile(env, "qa", {
			...entry(A, "qa-bot"),
			read: "new-read-0000",
		});
		expect((await readStore(env)).profiles.qa?.boundOnly).toBe(true);
		await saveProfile(env, "qa", entry(A, "other-bot"));
		expect((await readStore(env)).profiles.qa?.boundOnly).toBeUndefined();
		await setBoundOnly(env, "qa", true);
		expect(await setBoundOnly(env, "qa", false)).toBe(true);
		expect((await readStore(env)).profiles.qa?.boundOnly).toBeUndefined();
		await expect(setBoundOnly(env, "nobody", true)).rejects.toThrow(
			/No profile "nobody"/,
		);
	});

	test("a missing file is an empty store", async () => {
		expect(await readStore(freshEnv())).toEqual({ profiles: {}, defaults: {} });
	});

	test("save makes a 0700 directory and a 0600 file, with no temp file left", async () => {
		const env = freshEnv();
		await saveProfile(env, "dm", entry(A, "dm-bot"));
		const file = hostsFile(env);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
		expect(readdirSync(dirname(file))).toEqual(["hosts.json"]);
		expect((await readStore(env)).profiles.dm).toEqual(entry(A, "dm-bot"));
	});

	test("profiles are independent: two roles can share one host", async () => {
		const env = freshEnv();
		await saveProfile(env, "dm", entry(A, "dm-bot"));
		await saveProfile(env, "qa", entry(A, "qa-bot"));
		await saveProfile(env, "other", entry(B, "bot"));
		await saveProfile(env, "dm", entry(A, "dm-bot-2"));
		expect((await readStore(env)).profiles).toEqual({
			dm: entry(A, "dm-bot-2"),
			qa: entry(A, "qa-bot"),
			other: entry(B, "bot"),
		});
	});

	test("remove drops one profile and reports whether it existed", async () => {
		const env = freshEnv();
		await saveProfile(env, "dm", entry(A, "dm-bot"));
		await saveProfile(env, "qa", entry(A, "qa-bot"));
		expect(await removeProfile(env, "dm")).toBe(true);
		expect(await removeProfile(env, "dm")).toBe(false);
		expect(Object.keys((await readStore(env)).profiles)).toEqual(["qa"]);
	});

	test("a file from before defaults existed reads with no defaults", async () => {
		const env = freshEnv();
		await saveProfile(env, "dm", entry(A, "dm-bot"));
		await Bun.write(
			hostsFile(env),
			JSON.stringify({ profiles: { dm: entry(A, "dm-bot") } }),
		);
		chmodSync(hostsFile(env), 0o600);
		expect((await readStore(env)).defaults).toEqual({});
	});

	test("a hand-edited defaults entry that is not a string is dropped", async () => {
		const env = freshEnv();
		await saveProfile(env, "dm", entry(A, "dm-bot"));
		for (const defaults of [[], "dm", { [A]: ["dm"], [B]: "dm" }]) {
			await Bun.write(
				hostsFile(env),
				JSON.stringify({ profiles: { dm: entry(A, "dm-bot") }, defaults }),
			);
			chmodSync(hostsFile(env), 0o600);
			const got = (await readStore(env)).defaults;
			expect({ defaults, got }).toEqual({
				defaults,
				got:
					Array.isArray(defaults) || typeof defaults === "string"
						? {}
						: { [B]: "dm" },
			});
		}
	});

	test("a name from the object prototype is not a profile", async () => {
		const env = freshEnv();
		await saveProfile(env, "dm", entry(A, "dm-bot"));
		await expect(setDefault(env, "constructor")).rejects.toThrow(
			/No profile "constructor"/,
		);
		expect(await removeProfile(env, "toString")).toBe(false);
	});

	test("setDefault marks one profile per host and reports a change", async () => {
		const env = freshEnv();
		await saveProfile(env, "dm", entry(A, "dm-bot"));
		await saveProfile(env, "qa", entry(A, "qa-bot"));
		await saveProfile(env, "other", entry(B, "bot"));
		expect(await setDefault(env, "dm")).toBe(true);
		expect(await setDefault(env, "dm")).toBe(false);
		expect(await setDefault(env, "qa")).toBe(true);
		expect(await setDefault(env, "other")).toBe(true);
		expect((await readStore(env)).defaults).toEqual({
			[A]: "qa",
			[B]: "other",
		});
		await expect(setDefault(env, "ghost")).rejects.toThrow(
			/No profile "ghost"/,
		);
	});

	test("removing the default profile clears the default", async () => {
		const env = freshEnv();
		await saveProfile(env, "dm", entry(A, "dm-bot"));
		await setDefault(env, "dm");
		await removeProfile(env, "dm");
		expect((await readStore(env)).defaults).toEqual({});
	});

	test("moving the default profile to another host clears the old default", async () => {
		const env = freshEnv();
		await saveProfile(env, "dm", entry(A, "dm-bot"));
		await setDefault(env, "dm");
		await saveProfile(env, "dm", entry(A, "dm-bot-2"));
		expect((await readStore(env)).defaults).toEqual({ [A]: "dm" });
		await saveProfile(env, "dm", entry(B, "dm-bot"));
		expect((await readStore(env)).defaults).toEqual({});
	});

	test("a file that others can read is refused, with the fix command", async () => {
		const env = freshEnv();
		await saveProfile(env, "dm", entry(A, "dm-bot"));
		chmodSync(hostsFile(env), 0o644);
		await expect(readStore(env)).rejects.toThrow(`chmod 600 ${hostsFile(env)}`);
	});

	test("a file that is not valid JSON is an auth error", async () => {
		const env = freshEnv();
		await saveProfile(env, "dm", entry(A, "dm-bot"));
		await Bun.write(hostsFile(env), "{not json");
		chmodSync(hostsFile(env), 0o600);
		await expect(readStore(env)).rejects.toThrow(/not valid.*fgj auth/);
	});

	test("XDG_CONFIG_HOME wins over HOME", () => {
		expect(hostsFile({ HOME: "/h", XDG_CONFIG_HOME: "/x" })).toBe(
			"/x/fgj/hosts.json",
		);
		expect(hostsFile({ HOME: "/h" })).toBe("/h/.config/fgj/hosts.json");
	});
});

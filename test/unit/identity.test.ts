import { describe, expect, test } from "bun:test";
import {
	pickIdentity,
	profileName,
	selectProfile,
} from "../../src/auth/identity.ts";
import type { Store } from "../../src/auth/store.ts";

const A = "https://a.example";
const B = "https://b.example";
const p = (host: string, user: string) => ({
	host,
	user,
	read: `r-${user}-00000000`,
	write: `w-${user}-00000000`,
});
const store: Store = {
	profiles: { dm: p(A, "dm-bot"), qa: p(A, "qa-bot"), solo: p(B, "solo-bot") },
	defaults: {},
};

describe("selectProfile", () => {
	test("nothing selected gives undefined", () => {
		expect(selectProfile(store, undefined, undefined)).toBeUndefined();
	});

	test("FGJ_PROFILE or --as selects a profile", () => {
		expect(selectProfile(store, "dm", undefined)?.name).toBe("dm");
		expect(selectProfile(store, undefined, "qa")?.name).toBe("qa");
		expect(selectProfile(store, "qa", "qa")?.name).toBe("qa");
	});

	test("a --as that differs from FGJ_PROFILE is an identity mismatch", () => {
		expect(() => selectProfile(store, "dm", "qa")).toThrow(
			expect.objectContaining({
				code: "identity_mismatch",
				message: expect.stringContaining("FGJ_PROFILE is dm"),
			}),
		);
	});

	test("an unknown profile names the known ones", () => {
		expect(() => selectProfile(store, undefined, "ops")).toThrow(
			/No profile "ops"\. Profiles: dm, qa, solo/,
		);
	});
});

describe("bound-only profiles", () => {
	const bound: Store = {
		profiles: {
			dm: p(A, "dm-bot"),
			qa: { ...p(A, "qa-bot"), boundOnly: true },
		},
		defaults: {},
	};

	test("a bound-only profile acts through FGJ_PROFILE, never through --as alone", () => {
		expect(selectProfile(bound, "qa", undefined)?.name).toBe("qa");
		expect(selectProfile(bound, "qa", "qa")?.name).toBe("qa");
		expect(() => selectProfile(bound, undefined, "qa")).toThrow(
			expect.objectContaining({
				code: "identity_mismatch",
				message: expect.stringContaining("qa is bound only"),
			}),
		);
		// A profile with no mark still works with --as.
		expect(selectProfile(bound, undefined, "dm")?.name).toBe("dm");
	});

	test("the bound-only errors name no variable that gets around the rule", () => {
		// A model in a harness run read "acts only through FGJ_PROFILE" as "set FGJ_PROFILE instead".
		const messages: string[] = [];
		for (const call of [
			() => selectProfile(bound, undefined, "qa"),
			() =>
				pickIdentity({ ...bound, defaults: { [A]: "qa" } }, undefined, A, {}),
		]) {
			try {
				call();
			} catch (err) {
				messages.push((err as Error).message);
			}
		}
		expect(messages).toHaveLength(2);
		for (const message of messages) {
			expect(message).not.toContain("FGJ_PROFILE");
			expect(message).toContain("harness binder");
		}
	});

	test("a bound-only default never acts for an unbound call", () => {
		const withDefault = { ...bound, defaults: { [A]: "qa" } };
		expect(() => pickIdentity(withDefault, undefined, A, {})).toThrow(
			expect.objectContaining({
				code: "auth",
				message: expect.stringContaining("default profile qa"),
			}),
		);
	});
});

describe("pickIdentity", () => {
	test("a selected profile must match the target host", () => {
		const dm = selectProfile(store, "dm", undefined);
		expect(pickIdentity(store, dm, A, {})).toMatchObject({ as: "dm" });
		expect(() => pickIdentity(store, dm, B, {})).toThrow(
			/profile dm is for https:\/\/a\.example, but the target is https:\/\/b\.example/,
		);
	});

	test("with no selection, the default profile for the host is used", () => {
		const marked: Store = { ...store, defaults: { [A]: "qa" } };
		expect(pickIdentity(marked, undefined, A, {})).toMatchObject({
			as: "qa",
			user: "qa-bot",
		});
	});

	test("a selection wins over the default", () => {
		const marked: Store = { ...store, defaults: { [A]: "qa" } };
		const dm = selectProfile(marked, "dm", undefined);
		expect(pickIdentity(marked, dm, A, {})).toMatchObject({ as: "dm" });
	});

	test("one profile and no default fails closed, and the hint marks it", () => {
		expect(() => pickIdentity(store, undefined, B, {})).toThrow(
			expect.objectContaining({
				code: "auth",
				message: expect.stringContaining("no profile is the default"),
				hint: "fgj auth default solo",
			}),
		);
	});

	test("two profiles and no default fail closed, and never suggest --as", () => {
		let caught: unknown;
		try {
			pickIdentity(store, undefined, A, {});
		} catch (err) {
			caught = err;
		}
		expect(caught).toMatchObject({
			code: "auth",
			message: expect.stringContaining(
				"2 profiles for https://a.example: dm, qa",
			),
			hint: "fgj auth status",
		});
		expect(String((caught as Error).message)).not.toContain("--as");
	});

	test("a default that names a missing profile or another host is ignored", () => {
		const ghost: Store = { ...store, defaults: { [A]: "ghost", [B]: "dm" } };
		expect(() => pickIdentity(ghost, undefined, A, {})).toThrow(
			/no profile is the default/,
		);
		expect(() => pickIdentity(ghost, undefined, B, {})).toThrow(
			/no profile is the default/,
		);
	});

	test("a default or a selection that names a prototype key is no profile", () => {
		const proto: Store = { ...store, defaults: { [A]: "constructor" } };
		expect(() => pickIdentity(proto, undefined, A, {})).toThrow(
			/no profile is the default/,
		);
		expect(() => selectProfile(store, undefined, "constructor")).toThrow(
			/No profile "constructor"/,
		);
	});

	test("profiles without a default block the env tokens too", () => {
		const env = {
			FGJ_URL: B,
			FGJ_READ_TOKEN: "synthetic-read-token-for-identity-test",
		};
		expect(() => pickIdentity(store, undefined, B, env)).toThrow(
			/no profile is the default/,
		);
	});

	test("with no profile for the host, env tokens apply only to FGJ_URL", () => {
		const env = {
			FGJ_URL: "https://c.example/",
			FGJ_READ_TOKEN: "synthetic-read-token-for-identity-test",
		};
		expect(pickIdentity(store, undefined, "https://c.example", env)).toEqual({
			as: "env",
			user: undefined,
			read: "synthetic-read-token-for-identity-test",
			write: undefined,
		});
		expect(() =>
			pickIdentity(store, undefined, "https://d.example", env),
		).toThrow(/No profile for https:\/\/d\.example/);
	});
});

describe("profileName", () => {
	test("keeps a valid name and turns a login into one", () => {
		expect(profileName("dm")).toBe("dm");
		expect(profileName("Example.Agent")).toBe("example-agent");
		expect(() => profileName("--bad")).toThrow(/Profile names/);
	});
});

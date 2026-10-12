import { describe, expect, test } from "bun:test";
import { parseRemote, resolveTarget } from "../../src/forgejo/target.ts";

describe("parseRemote", () => {
	test.each([
		[
			"git@git.example.com:alice/tool.git",
			{ baseUrl: "https://git.example.com", owner: "alice", name: "tool" },
		],
		[
			"ssh://git@git.example.com:2222/alice/tool.git",
			{ baseUrl: "https://git.example.com", owner: "alice", name: "tool" },
		],
		[
			"https://git.example.com/alice/tool.git",
			{ baseUrl: "https://git.example.com", owner: "alice", name: "tool" },
		],
		[
			"http://127.0.0.1:3917/alice/tool",
			{ baseUrl: "http://127.0.0.1:3917", owner: "alice", name: "tool" },
		],
		[
			"https://example.com/forgejo/alice/tool.git",
			{ baseUrl: "https://example.com/forgejo", owner: "alice", name: "tool" },
		],
	])("%s", (url, expected) => {
		expect(parseRemote(url)).toEqual(expected);
	});

	test("rejects owner or name with characters outside a Forgejo slug", () => {
		expect(parseRemote("https://git.example.com/o%2Fx/tool.git")).toBeNull();
		expect(parseRemote("https://git.example.com/o/..")).toBeNull();
	});

	test("returns null for a URL with no owner/name", () => {
		expect(parseRemote("https://git.example.com/tool")).toBeNull();
		expect(parseRemote("/local/path")).toBeNull();
	});
});

describe("resolveTarget", () => {
	const base = {
		helpHint: "fgj help --json",
		envUrl: undefined,
		urlRemote: undefined,
		repoFlag: undefined,
		origin: null,
		storedHosts: [] as string[],
	};

	test("--repo with a . or .. part fails, so a path cannot leave the repository", () => {
		for (const repoFlag of [
			"../user",
			"x/..",
			"x/...git",
			"./x",
			"x/.",
			"../..",
		]) {
			expect({
				repoFlag,
				error: (() => {
					try {
						resolveTarget({
							...base,
							repoFlag,
							storedHosts: ["https://git.example.com"],
						});
						return "none";
					} catch (err) {
						return (err as { code: string }).code;
					}
				})(),
			}).toEqual({ repoFlag, error: "usage" });
		}
	});

	test("a known origin gives the host; --repo changes only owner/name", () => {
		const t = resolveTarget({
			...base,
			origin: "git@a.example:o/r.git",
			repoFlag: "x/y",
			storedHosts: ["https://a.example", "https://b.example"],
		});
		expect(t).toMatchObject({
			baseUrl: "https://a.example",
			owner: "x",
			name: "y",
			hostSource: "origin",
		});
	});

	test("an unknown origin (a GitHub clone) is skipped for the stored host", () => {
		const t = resolveTarget({
			...base,
			origin: "git@github.com:acme/app.git",
			repoFlag: "o/r",
			storedHosts: ["https://git.example.com"],
		});
		expect(t).toMatchObject({
			baseUrl: "https://git.example.com",
			owner: "o",
			name: "r",
			hostSource: "stored",
		});
	});

	test("an unknown origin with no --repo names the origin in the error", () => {
		expect(() =>
			resolveTarget({
				...base,
				origin: "git@github.com:acme/app.git",
				storedHosts: ["https://git.example.com"],
			}),
		).toThrow(/github\.com is not a stored Forgejo host.*--repo owner\/name/);
	});

	test("with no stored host, the hint is the exact fgj auth for the origin host", () => {
		try {
			resolveTarget({ ...base, origin: "git@git.example.com:o/r.git" });
			throw new Error("expected an error");
		} catch (err) {
			expect((err as { hint: string }).hint).toBe(
				"fgj auth https://git.example.com",
			);
		}
	});

	test("an issue URL wins over origin and gives host and repository", () => {
		const t = resolveTarget({
			...base,
			origin: "git@a.example:o/r.git",
			storedHosts: ["https://a.example"],
			urlRemote: { baseUrl: "https://b.example", owner: "u", name: "v" },
		});
		expect(t).toMatchObject({
			baseUrl: "https://b.example",
			owner: "u",
			name: "v",
			hostSource: "url",
		});
	});

	test("an issue URL and a different --repo is a usage error", () => {
		expect(() =>
			resolveTarget({
				...base,
				repoFlag: "x/y",
				urlRemote: { baseUrl: "https://b.example", owner: "u", name: "v" },
			}),
		).toThrow(/URL names u\/v, but --repo names x\/y/);
	});

	test("--repo drops a trailing .git", () => {
		const t = resolveTarget({
			...base,
			repoFlag: "o/r.git",
			storedHosts: ["https://a.example"],
		});
		expect(t).toMatchObject({ owner: "o", name: "r" });
	});

	test("two stored hosts and no FGJ_URL is a usage error", () => {
		expect(() =>
			resolveTarget({
				...base,
				repoFlag: "o/r",
				storedHosts: ["https://a.example", "https://b.example"],
			}),
		).toThrow(/2 hosts are stored/);
	});

	test("rejects a --repo value that is not owner/name", () => {
		expect(() =>
			resolveTarget({
				...base,
				repoFlag: "o/r/extra",
				storedHosts: ["https://a.example"],
			}),
		).toThrow(/owner\/name/);
	});
});

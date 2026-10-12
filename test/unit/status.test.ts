import { describe, expect, test } from "bun:test";
import { FgjError } from "../../src/core/errors.ts";
import type { ReadApi } from "../../src/forgejo/client.ts";
import type { Target } from "../../src/forgejo/target.ts";
import { runOf } from "../../src/verbs/run.ts";
import {
	combineStates,
	patternMatches,
	readChecks,
	requiredChecks,
} from "../../src/verbs/status.ts";

const target: Target = {
	baseUrl: "https://git.example.com",
	owner: "o",
	name: "r",
	repoFromFlag: false,
	hostSource: "origin",
};

describe("combineStates", () => {
	test("follows Forgejo 16: error or failure gives failure, then warning, pending, success", () => {
		expect(combineStates([])).toBe("none");
		expect(combineStates(["success"])).toBe("success");
		expect(combineStates(["error", "success"])).toBe("failure");
		expect(combineStates(["failure", "warning"])).toBe("failure");
		expect(combineStates(["warning", "pending"])).toBe("warning");
		expect(combineStates(["pending", "success"])).toBe("pending");
		// Forgejo 16 ranks skipped above success: all skipped reads skipped.
		expect(combineStates(["skipped"])).toBe("skipped");
		expect(combineStates(["skipped", "success"])).toBe("success");
		expect(combineStates(["skipped", "pending"])).toBe("pending");
		// Forgejo stores any state string: an unknown one is not a pass.
		expect(combineStates(["running", "success"])).toBe("pending");
	});
});

describe("patternMatches", () => {
	test("* matches any text with /, ? matches one character, and the rest is literal", () => {
		expect(patternMatches("ci/*", "ci/lint")).toBe(true);
		expect(patternMatches("Verify / *", "Verify / verify (pull_request)")).toBe(
			true,
		);
		expect(patternMatches("*", "a/b/c")).toBe(true);
		expect(patternMatches("ci/?int", "ci/lint")).toBe(true);
		expect(
			patternMatches(
				"Verify / verify (pull_request)",
				"Verify / verify (pull_request)",
			),
		).toBe(true);
		expect(patternMatches("ci/lint", "ci/lint2")).toBe(false);
		expect(patternMatches("a.b", "axb")).toBe(false);
		expect(patternMatches("(x)", "x")).toBe(false);
		// fgj reads * and ? only. A pattern with other glob syntax never
		// matches, so it shows as missing: never a false pass.
		for (const pattern of ["ci/{lint,test}", "ci/[lt]int", "ci/\\*", "ci/]"]) {
			for (const context of [pattern, "ci/lint", "ci/test", "ci/*", "ci/\\x"]) {
				expect({
					pattern,
					context,
					match: patternMatches(pattern, context),
				}).toEqual({
					pattern,
					context,
					match: false,
				});
			}
		}
		// ? is one character, an emoji too.
		expect(patternMatches("ci/?", "ci/😀")).toBe(true);
		// Many stars stay fast on a long context.
		const started = performance.now();
		expect(patternMatches("*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(3000))).toBe(
			false,
		);
		// A long brace pattern is text: no expansion, no memory blow-up.
		expect(patternMatches("{a,b}".repeat(40), "ci/lint")).toBe(false);
		expect(performance.now() - started).toBeLessThan(200);
	});
});

describe("runOf", () => {
	test("reads the run number of this repository's Actions URLs only", () => {
		expect(runOf("/o/r/actions/runs/53/jobs/0", target)).toBe(53);
		expect(runOf("https://git.example.com/o/r/actions/runs/7", target)).toBe(7);
		expect(runOf("/O/R/actions/runs/8/jobs/1/attempt/2", target)).toBe(8);
		expect(runOf("/o/other/actions/runs/53", target)).toBeUndefined();
		expect(
			runOf("https://elsewhere.example/o/r/actions/runs/53", target),
		).toBeUndefined();
		expect(runOf("https://ci.example/build/9", target)).toBeUndefined();
	});
});

describe("readChecks", () => {
	/** A fake client that answers one page of statuses, with the header total. */
	const api = (statuses: object[], total = statuses.length) =>
		({
			async getCounted() {
				return { data: { statuses }, total };
			},
		}) as unknown as Pick<ReadApi, "getCounted">;

	test("a bad or unsafe target_url never breaks the read or reaches the output", async () => {
		const out = await readChecks(
			api([
				{
					status: "success",
					context: "a",
					description: null,
					target_url: "http://[",
				},
				{
					status: "success",
					context: "b",
					description: "",
					target_url: "https://user:secret@ci.example/x",
				},
				{
					status: "success",
					context: "c",
					description: null,
					target_url: "javascript:alert(1)",
				},
				{
					status: "success",
					context: "d",
					description: null,
					target_url: "//evil.example/x",
				},
			]),
			target,
			"a".repeat(40),
		);
		expect(out.checks).toEqual([
			{ context: "a", state: "success" },
			{ context: "b", state: "success", url: "https://ci.example/x" },
			{ context: "c", state: "success" },
			{ context: "d", state: "success", url: "https://evil.example/x" },
		]);
		expect(JSON.stringify(out)).not.toContain("secret");
	});

	test("more checks than fgj reads fail loudly, and never hide a failure", async () => {
		const full = Array.from({ length: 50 }, (_, i) => ({
			status: "success",
			context: `c${i}`,
			description: null,
			target_url: null,
		}));
		await expect(
			readChecks(api(full, 5000), target, "a".repeat(40)),
		).rejects.toThrow(/more than 1000 checks/);
	});
});

describe("paging and the base branch", () => {
	test("a server that pages below 50 still gives every check, up to the header total", async () => {
		const pages = [
			[
				{
					status: "success",
					context: "a",
					description: null,
					target_url: null,
				},
			],
			[
				{
					status: "failure",
					context: "b",
					description: null,
					target_url: null,
				},
			],
		];
		const calls: number[] = [];
		const api = {
			async getCounted(_path: string, query: { page: number }) {
				calls.push(query.page);
				return { data: { statuses: pages[query.page - 1] ?? [] }, total: 2 };
			},
		} as unknown as Pick<ReadApi, "getCounted">;
		const out = await readChecks(api, target, "a".repeat(40));
		expect(out.state).toBe("failure");
		expect(out.total).toBe(2);
		expect(calls).toEqual([1, 2]);
	});

	test("a full page with no count reads on until an empty page", async () => {
		const full = Array.from({ length: 50 }, (_, i) => ({
			status: "success",
			context: `c${i}`,
			description: null,
			target_url: null,
		}));
		const pages = [
			full,
			[
				{
					status: "failure",
					context: "z",
					description: null,
					target_url: null,
				},
			],
		];
		const api = {
			async getCounted(_path: string, query: { page: number }) {
				return { data: { statuses: pages[query.page - 1] ?? [] } };
			},
		} as unknown as Pick<ReadApi, "getCounted">;
		const out = await readChecks(api, target, "a".repeat(40));
		expect(out.total).toBe(51);
		expect(out.state).toBe("failure");
	});

	test("a deleted base branch fails with not_found that names the branch", async () => {
		const api = {
			async get() {
				throw new FgjError(
					"not_found",
					"Not found (HTTP 404)",
					"fgj help",
					404,
				);
			},
		} as unknown as Pick<ReadApi, "get">;
		const err = (await requiredChecks(api, target, "release/1").catch(
			(e: unknown) => e,
		)) as FgjError;
		expect(err.code).toBe("not_found");
		expect(err.message).toContain(
			"The base branch release/1 does not exist in o/r",
		);
	});
});

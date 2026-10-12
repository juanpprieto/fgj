import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/core/args.ts";
import { FgjError } from "../../src/core/errors.ts";
import type { Verb } from "../../src/core/verb.ts";
import {
	apiGet,
	repoPath,
	selectPaths,
	shapeResult,
	shrinkQuery,
} from "../../src/verbs/api.ts";

describe("repoPath", () => {
	test("accepts the listed families, with multi-segment refs and file paths", () => {
		for (const path of [
			".",
			"pulls",
			"pulls/10/commits",
			"commits/0123abc/statuses",
			"actions/runs/5/jobs",
			"actions/tasks",
			"branches/feat/9-org",
			"contents/docs/a.md",
			"releases/tags/v1.0.0",
			"issues/3/timeline",
		]) {
			expect({
				path,
				ok: repoPath(path) === (path === "." ? "" : path),
			}).toEqual({ path, ok: true });
		}
	});

	test("refuses everything else, including traversal hidden in a family", () => {
		for (const path of [
			"actions/variables",
			"actions/secrets",
			"actions/runs/1/logs",
			"commits/feat/x/status",
			"hooks",
			"keys",
			"contents/../hooks",
			"contents/a/../../hooks",
			"branches/./x",
			"contents/%2e%2e/x",
			"pulls/10",
			"pulls/10/files/x",
			"",
			"./pulls",
			"pulls/",
			"pulls\nhooks",
		]) {
			expect(() => repoPath(path)).toThrow("is not a path");
		}
	});
});

describe("selectPaths", () => {
	test("keeps dotted paths through objects and arrays, in the value's key order", () => {
		const data = {
			total_count: 2,
			workflow_runs: [
				{ id: 1, status: "ok", head: { sha: "a", ref: "x" } },
				{ id: 2, status: "bad", head: { sha: "b", ref: "y" } },
			],
			other: true,
		};
		expect(
			selectPaths(data, [
				["workflow_runs", "id"],
				["total_count"],
				["workflow_runs", "head", "sha"],
			]),
		).toEqual({
			total_count: 2,
			workflow_runs: [
				{ id: 1, head: { sha: "a" } },
				{ id: 2, head: { sha: "b" } },
			],
		});
	});

	test("a whole key wins over a deeper path to it, and a missing key is left out", () => {
		expect(
			selectPaths({ a: { b: 1, c: 2 } }, [["a"], ["a", "b"], ["z"]]),
		).toEqual({
			a: { b: 1, c: 2 },
		});
	});
});

describe("the repeatable --query flag", () => {
	test("each use adds one value, in order", () => {
		const args = parseArgs(
			["pulls", "--query", "state=open", "--query=limit=5"],
			apiGet as Verb,
		);
		expect(args.flags.query).toEqual(["state=open", "limit=5"]);
	});
});

describe("the over-cap hint", () => {
	test("keeps the first item: the page size the server used, a divisor of it, and the page moved to match", () => {
		expect(
			shrinkQuery(
				[
					["limit", "50"],
					["page", "3"],
				],
				50,
				4,
			),
		).toEqual([
			["limit", "10"],
			["page", "11"],
		]);
		expect(shrinkQuery([["state", "open"]], 30, 4)).toEqual([
			["state", "open"],
			["limit", "7"],
		]);
	});

	test("a limit above the server's page, and no limit at all, start at the item the server served", () => {
		// limit=100 on a 50-item server: page 2 held items 50-99.
		expect(
			shrinkQuery(
				[
					["limit", "100"],
					["page", "2"],
				],
				50,
				2,
			),
		).toEqual([
			["limit", "25"],
			["page", "3"],
		]);
		// No limit: the server's default of 30, so page 3 held items 60-89.
		expect(shrinkQuery([["page", "3"]], 30, 2)).toEqual([
			["limit", "15"],
			["page", "5"],
		]);
	});

	test("per_page stays the page key when the query uses it", () => {
		expect(shrinkQuery([["per_page", "1000"]], 1000, 4)).toEqual([
			["per_page", "250"],
		]);
	});
});

describe("shapeResult", () => {
	test("a wrapper object on a paged endpoint gets next too", () => {
		const out = shapeResult(
			{ total_count: 3, workflow_runs: [{ id: 1 }] },
			'<https://h/api/v1/repos/o/r/actions/runs?limit=1&page=2>; rel="next"',
			3,
			(q) => `cmd ${q.map(([k, v]) => `${k}=${v}`).join(" ")}`,
			[["limit", "1"]],
		);
		expect(out).toEqual({
			total_count: 3,
			workflow_runs: [{ id: 1 }],
			next: "cmd limit=1 page=2",
		});
	});
});

describe("the page-size key", () => {
	const prepare = (argv: string[]) =>
		apiGet.prepare(parseArgs(argv, apiGet as Verb), {
			cwd: "/",
			home: undefined,
		});

	test("each family takes only the size key its endpoint reads", () => {
		expect(() => prepare(["pulls", "--query", "per_page=2"])).toThrow("limit");
		expect(() =>
			prepare([
				"pulls/1/commits",
				"--query",
				"limit=4",
				"--query",
				"per_page=2",
			]),
		).toThrow("limit");
		expect(() => prepare(["git/trees/abc", "--query", "limit=2"])).toThrow(
			"per_page",
		);
		expect(prepare(["git/trees/abc", "--query", "per_page=2"]).query).toEqual([
			["per_page", "2"],
		]);
	});
});

describe("the over-cap hint never repeats the call", () => {
	test("one item over the cap advises --fields, not the same command", async () => {
		const input = apiGet.prepare(
			parseArgs(["pulls", "--query", "limit=1"], apiGet as Verb),
			{ cwd: "/", home: undefined },
		);
		const api = {
			getPaged: async () => ({
				data: [{ body: "x".repeat(30_000) }],
				link: '<https://h/api/v1/repos/o/r/pulls?limit=1&page=2>; rel="next"',
				total: 5,
			}),
		};
		const ctx = {
			target: { owner: "o", name: "r" },
			api,
			commandWith: () => "fgj read api get pulls --query limit=1",
			commandFor: () => "",
		};
		const err = await (
			apiGet.run as (i: unknown, c: unknown) => Promise<unknown>
		)(input, ctx).catch((e: unknown) => e);
		expect((err as { hint: string }).hint).toBe("fgj help api get");
	});
});

describe("the over-cap hint", () => {
	const ctxFor = (data: unknown) =>
		({
			target: {
				baseUrl: "https://git.example.com",
				owner: "o",
				name: "r",
				repoFromFlag: false,
				hostSource: "origin",
			},
			api: { getPaged: async () => ({ data, link: null }) },
			commandWith: (
				flags: Record<string, unknown>,
				positionals: readonly string[],
			) =>
				[
					"fgj read api get",
					...positionals,
					...((flags.query as string[] | undefined) ?? []).flatMap((q) => [
						"--query",
						q,
					]),
				].join(" "),
		}) as unknown as Parameters<typeof apiGet.run>[1];

	test("when one item alone passes the cap, the hint is --fields, not a smaller limit", async () => {
		const big = Array.from({ length: 2 }, (_, i) => ({
			number: i,
			body: "x".repeat(30_000),
		}));
		const input = apiGet.prepare(
			{ positionals: ["pulls"], flags: { query: ["limit=2"] } },
			{ cwd: "/", home: undefined },
		);
		const err = await apiGet.run(input, ctxFor(big)).catch((e: FgjError) => e);
		expect(err).toBeInstanceOf(FgjError);
		expect((err as FgjError).hint).toBe("fgj help api get");
		expect((err as FgjError).message).toContain("--fields");
		expect((err as FgjError).message).not.toContain("--query limit=N");
	});

	test("when one item fits, the hint is a smaller limit", async () => {
		const items = Array.from({ length: 4 }, (_, i) => ({
			number: i,
			body: "x".repeat(9_000),
		}));
		const input = apiGet.prepare(
			{ positionals: ["pulls"], flags: { query: ["limit=4"] } },
			{ cwd: "/", home: undefined },
		);
		const err = await apiGet
			.run(input, ctxFor(items))
			.catch((e: FgjError) => e);
		expect((err as FgjError).hint).toMatch(
			/^fgj read api get pulls --query limit=\d$/,
		);
	});
});

describe("review fixes: api get", () => {
	const ctxFor = (data: unknown) =>
		({
			target: {
				baseUrl: "https://git.example.com",
				owner: "o",
				name: "r",
				repoFromFlag: false,
				hostSource: "origin",
			},
			api: {
				getPaged: async () => ({ data, link: null }),
				get: async () => ({ default_paging_num: 30, max_response_items: 50 }),
			},
			commandWith: (
				flags: Record<string, unknown>,
				positionals: readonly string[],
			) =>
				[
					"fgj read api get",
					...positionals,
					...((flags.query as string[] | undefined) ?? []).flatMap((q) => [
						"--query",
						q,
					]),
				].join(" "),
		}) as unknown as Parameters<typeof apiGet.run>[1];
	const prep = (
		path: string,
		flags: Parameters<typeof apiGet.prepare>[0]["flags"],
	) =>
		apiGet.prepare(
			{ positionals: [path], flags },
			{ cwd: "/", home: undefined },
		);

	test("a wrapper with fewer items than the limit asked: the hint counts the items it got", async () => {
		const runs = Array.from({ length: 10 }, (_, i) => ({
			id: i,
			body: "x".repeat(17_000),
		}));
		const err = await apiGet
			.run(
				prep("actions/runs", { query: ["limit=100"] }),
				ctxFor({ total_count: 10, workflow_runs: runs }),
			)
			.catch((e: FgjError) => e);
		expect((err as FgjError).hint).toBe(
			"fgj read api get actions/runs --query limit=1",
		);
	});

	test("a nested field that matches nothing fails; an empty list does not", async () => {
		for (const [path, fields, data] of [
			[
				"actions/runs",
				"workflow_runs.nope",
				{ total_count: 2, workflow_runs: [{ id: 1 }, { id: 2 }] },
			],
			["commits", "commit.mesage", [{ sha: "a", commit: { message: "m" } }]],
		] as const) {
			const err = await apiGet
				.run(prep(path, { fields }), ctxFor(data))
				.catch((e: FgjError) => e);
			expect({ fields, code: (err as FgjError).code }).toEqual({
				fields,
				code: "usage",
			});
		}
		for (const [path, fields, data] of [
			["commits", "sha", []],
			[
				"actions/runs",
				"workflow_runs.id",
				{ total_count: 0, workflow_runs: [] },
			],
			["pulls", "number,labels", [{ number: 1, labels: [] }]],
		] as const) {
			await expect(
				apiGet.run(prep(path, { fields }), ctxFor(data)),
			).resolves.toBeDefined();
		}
	});

	test("a field that exists with a null value counts as a match", async () => {
		const out = await apiGet.run(
			prep("pulls", { fields: "milestone.title" }),
			ctxFor([{ number: 1, milestone: null }]),
		);
		expect(out).toBeDefined();
	});

	test("an object that is not a paged wrapper gets no smaller-limit hint", async () => {
		const release = {
			tag_name: "v1",
			body: "x".repeat(40_000),
			assets: [{ id: 1 }, { id: 2 }],
		};
		const err = await apiGet
			.run(prep("releases/tags/v1", {}), ctxFor(release))
			.catch((e: FgjError) => e);
		expect((err as FgjError).hint).toBe("fgj help api get");
	});

	test("a runs wrapper gets next and total from total_count, and its page", async () => {
		const runs = Array.from({ length: 2 }, (_, i) => ({ id: i }));
		const out = (await apiGet.run(
			prep("actions/runs", { query: ["limit=2"], fields: "workflow_runs.id" }),
			ctxFor({ total_count: 5, workflow_runs: runs }),
		)) as { next: string; total: number };
		expect(out.total).toBe(5);
		expect(out.next).toBe(
			"fgj read api get actions/runs --query limit=2 --query page=2",
		);
		const last = (await apiGet.run(
			prep("actions/runs", { query: ["limit=2", "page=3"] }),
			ctxFor({ total_count: 5, workflow_runs: [{ id: 9 }] }),
		)) as { next: unknown };
		expect(last.next).toBeNull();
	});

	test("next uses the page size that the server serves, which caps limit at max_response_items", async () => {
		const page = (n: number, from: number) =>
			Array.from({ length: n }, (_, i) => ({ id: from + i }));
		const capped = (await apiGet.run(
			prep("actions/runs", { query: ["limit=100", "page=2"] }),
			ctxFor({ total_count: 120, workflow_runs: page(50, 50) }),
		)) as { next: string | null };
		expect(capped.next).toBe(
			"fgj read api get actions/runs --query limit=100 --query page=3",
		);
		const last = (await apiGet.run(
			prep("actions/runs", { query: ["page=2"] }),
			ctxFor({ total_count: 44, workflow_runs: page(14, 30) }),
		)) as { next: string | null };
		expect(last.next).toBeNull();
	});

	test("page 0 fails, because Forgejo does not page at 0", () => {
		expect(() => prep("actions/runs", { query: ["page=0"] })).toThrow(/page/);
	});

	test("past page 1, a short page over the cap still gets a limit that fits", async () => {
		const runs = Array.from({ length: 14 }, (_, i) => ({
			id: 30 + i,
			body: "x".repeat(15_000),
		}));
		const err = await apiGet
			.run(
				prep("actions/runs", { query: ["page=2"] }),
				ctxFor({ total_count: 44, workflow_runs: runs }),
			)
			.catch((e: FgjError) => e);
		expect((err as FgjError).hint).toBe(
			"fgj read api get actions/runs --query limit=1 --query page=31",
		);
	});
});

import { describe, expect, test } from "bun:test";
import { FgjError } from "../../src/core/errors.ts";
import type { VerbContext } from "../../src/core/verb.ts";
import type { WriteApi } from "../../src/forgejo/client.ts";
import {
	MERGE_RETRY_WAITS_MS,
	mergePull,
	prMerge,
	retitle,
} from "../../src/verbs/pr.ts";

describe("retitle", () => {
	test("adds, keeps, and removes the draft prefix apart from the title text", () => {
		expect(retitle("", "Add login", true)).toBe("WIP: Add login");
		expect(retitle("Add login", undefined, true)).toBe("WIP: Add login");
		expect(retitle("WIP: Add login", undefined, false)).toBe("Add login");
		expect(retitle("[wip]Add login", undefined, false)).toBe("Add login");
		expect(retitle("WIP: Add login", "Add the login page", undefined)).toBe(
			"WIP: Add the login page",
		);
		// The prefix keeps its form while the PR stays a draft.
		expect(retitle("[WIP] Add login", "Login", true)).toBe("[WIP] Login");
		expect(retitle("Add login", "Login", undefined)).toBe("Login");
		// A prefix that is not at the start is title text.
		expect(retitle("Fix WIP: parsing", undefined, false)).toBe(
			"Fix WIP: parsing",
		);
	});
});

/** A PR as the fake server returns it. */
function pullAt(sha: string, over: Record<string, unknown> = {}) {
	return {
		number: 12,
		title: "Ship it",
		state: "open",
		draft: false,
		merged: false,
		mergeable: true,
		merge_commit_sha: null,
		base: { ref: "main", sha: "b".repeat(40) },
		head: { ref: "feat/x", sha },
		...over,
	};
}

const PIN = "a".repeat(40);

/**
 * A fake WriteApi for `pr merge`: `reads` gives the PR for each read in turn
 * (the last one repeats), and `posts` gives the outcome of each merge request.
 */
function fakeMerge(
	reads: Record<string, unknown>[],
	posts: (FgjError | null)[],
) {
	const calls: string[] = [];
	const bodies: unknown[] = [];
	let read = 0;
	let post = 0;
	const api = {
		async get(path: string) {
			calls.push(`GET ${path}`);
			return reads[Math.min(read++, reads.length - 1)];
		},
		async getCounted(path: string) {
			calls.push(`GET ${path}`);
			return { data: { statuses: [] } };
		},
		async send(method: string, path: string, body?: unknown) {
			calls.push(`${method} ${path}`);
			bodies.push(body);
			const outcome = posts[post++];
			if (outcome) throw outcome;
			return null;
		},
	};
	const ctx = {
		target: {
			baseUrl: "https://git.example.com",
			owner: "o",
			name: "r",
			repoFromFlag: false,
			hostSource: "origin" as const,
		},
		api: api as unknown as WriteApi,
		commandWith: () => "fgj destroy pr merge 12 --style merge",
		commandFor: (words: string, positionals: readonly string[]) =>
			["fgj", words, ...positionals].join(" "),
	} satisfies Pick<
		VerbContext<WriteApi>,
		"target" | "api" | "commandWith" | "commandFor"
	>;
	return { ctx, calls, bodies };
}

const input = {
	ref: { number: 12, canonical: "12" },
	style: "merge" as const,
	dryRun: false,
};

const tryLater = () =>
	new FgjError(
		"api",
		"Forgejo returned HTTP 405 POST /repos/o/r/pulls/12/merge: Please try again later",
		"fgj help",
		405,
	);

describe("mergePull", () => {
	test("retries a 'try again later' answer with the first head pinned, while Forgejo checks the PR", async () => {
		const waits: number[] = [];
		const { ctx, calls, bodies } = fakeMerge(
			[
				pullAt(PIN),
				// Forgejo reports mergeable:false while it checks the PR.
				pullAt(PIN, { mergeable: false }),
				pullAt(PIN, { merged: true, merge_commit_sha: "c".repeat(40) }),
			],
			[tryLater(), null],
		);
		const out = await mergePull(input, ctx, async (ms) => waits.push(ms));
		expect(out).toEqual({
			changed: true,
			pr: 12,
			merge_commit: "c".repeat(40),
		});
		expect(waits).toEqual([2000]);
		expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(2);
		for (const body of bodies) {
			expect(body).toEqual({
				Do: "merge",
				head_commit_id: PIN,
				delete_branch_after_merge: false,
			});
		}
	});

	test("stops after 3 retries in about 10 seconds with conflict, and the hint repeats the command", async () => {
		const waits: number[] = [];
		const { ctx, calls } = fakeMerge(
			[pullAt(PIN)],
			[tryLater(), tryLater(), tryLater(), tryLater()],
		);
		const err = await mergePull(input, ctx, async (ms) => waits.push(ms)).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(FgjError);
		expect((err as FgjError).code).toBe("conflict");
		expect((err as FgjError).hint).toBe(
			"fgj destroy pr merge 12 --style merge",
		);
		expect(waits).toEqual([...MERGE_RETRY_WAITS_MS]);
		expect(waits.reduce((a, b) => a + b, 0)).toBe(10_000);
		expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(4);
	});

	test("a retry never merges a new push: a moved head fails with conflict", async () => {
		const { ctx, calls } = fakeMerge(
			[pullAt(PIN), pullAt("d".repeat(40))],
			[tryLater()],
		);
		const err = (await mergePull(input, ctx, async () => {}).catch(
			(e: unknown) => e,
		)) as FgjError;
		expect(err.code).toBe("conflict");
		expect(err.message).toContain("moved to dddddddddd");
		expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
	});

	test("a lost answer reads the PR: merged at the pinned head is changed:true, otherwise the error stays", async () => {
		const lost = () =>
			new FgjError(
				"api",
				"Cannot reach https://git.example.com",
				"fgj auth status",
			);
		const merged = fakeMerge(
			[
				pullAt(PIN),
				pullAt(PIN, { merged: true, merge_commit_sha: "e".repeat(40) }),
			],
			[lost()],
		);
		expect(await mergePull(input, merged.ctx, async () => {})).toEqual({
			changed: true,
			pr: 12,
			merge_commit: "e".repeat(40),
		});
		const open = fakeMerge([pullAt(PIN)], [lost()]);
		const err = (await mergePull(input, open.ctx, async () => {}).catch(
			(e: unknown) => e,
		)) as FgjError;
		expect(err.code).toBe("api");
		expect(err.message).toContain("Cannot reach");
	});

	test("a server error reads the PR too", async () => {
		const { ctx } = fakeMerge(
			[
				pullAt(PIN),
				pullAt(PIN, { merged: true, merge_commit_sha: "f".repeat(40) }),
			],
			[new FgjError("api", "Forgejo returned HTTP 502", "fgj help", 502)],
		);
		expect(await mergePull(input, ctx, async () => {})).toMatchObject({
			changed: true,
		});
	});

	test("a 409 with the head unchanged is a refusal with the server's reason, not a moved head", async () => {
		const { ctx, calls } = fakeMerge(
			[pullAt(PIN)],
			[
				new FgjError(
					"conflict",
					"Conflict (HTTP 409) POST /repos/o/r/pulls/12/merge: CONFLICT (content): Merge conflict in f.txt",
					"fgj help",
					409,
				),
			],
		);
		const err = (await mergePull(input, ctx, async () => {}).catch(
			(e: unknown) => e,
		)) as FgjError;
		expect(err.code).toBe("conflict");
		expect(err.message).toBe(
			"Forgejo refused the merge: CONFLICT (content): Merge conflict in f.txt",
		);
		expect(err.hint).toBe("fgj read pr get 12");
		expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
	});

	test("a 409 after a push names the moved head", async () => {
		const { ctx } = fakeMerge(
			[pullAt(PIN), pullAt("d".repeat(40))],
			[
				new FgjError(
					"conflict",
					"Conflict (HTTP 409) POST /repos/o/r/pulls/12/merge: head out of date",
					"fgj help",
					409,
				),
			],
		);
		const err = (await mergePull(input, ctx, async () => {}).catch(
			(e: unknown) => e,
		)) as FgjError;
		expect(err.message).toContain("moved to dddddddddd");
	});

	test("a 405 or 409 because another call merged it first returns changed:false", async () => {
		for (const status of [405, 409]) {
			const { ctx } = fakeMerge(
				[
					pullAt(PIN),
					pullAt(PIN, { merged: true, merge_commit_sha: "9".repeat(40) }),
				],
				[
					new FgjError(
						status === 405 ? "api" : "conflict",
						`HTTP ${status} POST /repos/o/r/pulls/12/merge: `,
						"fgj help",
						status,
					),
				],
			);
			expect(await mergePull(input, ctx, async () => {})).toEqual({
				changed: false,
				pr: 12,
				merge_commit: "9".repeat(40),
			});
		}
	});

	test("a refusal with no reason says so", async () => {
		const { ctx } = fakeMerge(
			[pullAt(PIN)],
			[
				new FgjError(
					"api",
					"Forgejo returned HTTP 405 POST /repos/o/r/pulls/12/merge: ",
					"fgj help",
					405,
				),
			],
		);
		const err = (await mergePull(input, ctx, async () => {}).catch(
			(e: unknown) => e,
		)) as FgjError;
		expect(err.message).toBe(
			"Forgejo refused the merge (HTTP 405) and gave no reason.",
		);
	});

	test("the dry run's default style is one that the repository allows", async () => {
		const pull = pullAt(PIN);
		const repo = {
			default_merge_style: "merge",
			allow_merge_commits: false,
			allow_rebase: false,
			allow_rebase_explicit: true,
			allow_squash_merge: true,
		};
		const { ctx } = fakeMerge([pull, repo, { enable_status_check: false }], []);
		const out = await mergePull(
			{ ref: input.ref, dryRun: true },
			ctx,
			async () => {},
		);
		expect(out.style).toBe("rebase-merge");
	});

	test("the pi effect accepts every style and full SHA that prepare accepts", () => {
		const values = prMerge.effect?.values ?? {};
		for (const style of [
			"merge",
			"rebase",
			"rebase-merge",
			"squash",
			"fast-forward-only",
		]) {
			expect(new RegExp(values.style as string).test(style)).toBe(true);
			expect<string | undefined>(
				prMerge.prepare(
					{ positionals: ["12"], flags: { style } },
					{
						cwd: "/",
						home: undefined,
					},
				).style,
			).toBe(style);
		}
		expect(new RegExp(values.head as string).test(PIN)).toBe(true);
		expect(new RegExp(values.head as string).test("a".repeat(7))).toBe(false);
	});
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FgjError } from "../../src/core/errors.ts";
import type { VerbContext } from "../../src/core/verb.ts";
import {
	cleanLog,
	ERROR_BLOCK_MAX,
	errorBlock,
	GAP,
	jobResult,
	LOG_LINE_MAX,
	matchLines,
} from "../../src/forgejo/actions.ts";
import type { ReadApi } from "../../src/forgejo/client.ts";
import { rerunPlan, runGet, runLog } from "../../src/verbs/run.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "actions");
const fixture = (name: string) =>
	Bun.file(join(FIXTURES, `${name}.log`)).text();

describe("Actions log reader", () => {
	test("cleanLog removes timestamps and colors, drops masked lines, and cuts long lines", () => {
		const text = [
			"2026-09-27T08:13:12.1708799Z \x1b[31mFAIL\x1b[39m a.test.ts",
			"2026-09-27T08:13:12.1708799Z AUTHORIZATION: basic ***",
			`2026-09-27T08:13:12.1708799Z ${"x".repeat(70_000)}`,
			"",
		].join("\n");
		const lines = cleanLog(text);
		expect(lines[0]).toBe("FAIL a.test.ts");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toHaveLength(LOG_LINE_MAX + GAP.length);
	});

	test("the error block of a synthetic Vitest timeout holds the error line and the exit line, in under 60 lines", async () => {
		const lines = cleanLog(await fixture("failed-vitest-timeout"));
		const block = errorBlock(lines);
		expect(block.length).toBeLessThanOrEqual(ERROR_BLOCK_MAX);
		expect(block).toContain("Error: spawnSync pi ETIMEDOUT");
		expect(block.at(-1)).toBe("⚙️ [runner]: exitcode '1': failure");
		// Post steps after the failure line are not in the block.
		expect(block.join("\n")).not.toContain("Post Check out");
		expect(jobResult(lines)).toBe("failure");
	});

	test("the error block of a synthetic tsc failure is the error and the exit lines", async () => {
		const block = errorBlock(cleanLog(await fixture("failed-tsc")));
		expect(block).toContain(
			"src/ci-type-error-proof.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
		);
		expect(block.length).toBeLessThan(10);
	});

	test("a passed log has no error block and reads as success", async () => {
		const lines = cleanLog(await fixture("passed"));
		expect(errorBlock(lines)).toEqual([]);
		expect(jobResult(lines)).toBe("success");
	});

	test("over the limit, the block keeps the parts nearest the end", () => {
		const lines: string[] = [];
		for (let i = 0; i < 40; i++)
			lines.push(`ok ${i}`, `FAIL t${i}`, ...Array(12).fill("."));
		lines.push("⚙️ [runner]: exitcode '1': failure");
		const block = errorBlock(lines, 30);
		expect(block.length).toBeLessThanOrEqual(30);
		expect(block).toContain("FAIL t39");
		expect(block).not.toContain("FAIL t0");
		expect(block.at(-1)).toBe("⚙️ [runner]: exitcode '1': failure");
		expect(block).toContain(GAP);
	});

	test("matchLines finds a text in the middle without case, with context, and counts the hits", async () => {
		const lines = cleanLog(await fixture("passed"));
		const found = matchLines(lines, ["TEST FILES"]);
		expect(found.hits).toBeGreaterThan(0);
		expect(found.lines.some((l) => /Test Files/.test(l))).toBe(true);
		expect(matchLines(["a", "b"], ["zzz"])).toEqual({ lines: [], hits: 0 });
	});
});

/** A fake API: one run (API id 124, web number 40) with one job, and a log. */
function fakeCtx(
	log: string | FgjError,
	jobs = [
		{ id: 126, name: "verify", status: "failure", task_id: 122, attempt: 1 },
	],
) {
	const seen: { path: string; query?: Record<string, unknown> }[] = [];
	const api = {
		get: async (path: string, query?: Record<string, unknown>) => {
			if (path.endsWith("/actions/runs") && query?.run_number === 40) {
				return {
					workflow_runs: [
						{
							id: 124,
							index_in_repo: 40,
							status: "failure",
							event: "pull_request",
							prettyref: "#133",
							commit_sha: "0123456789abcdef0123456789abcdef01234567",
							title: "test: synthetic timeout",
							html_url: "https://git.example.com/o/r/actions/runs/40",
						},
					],
				};
			}
			if (path.endsWith("/actions/runs/124/jobs")) return jobs;
			return { workflow_runs: [] };
		},
		// The log path must name a job id, never the run id or the task id.
		getText: async (path: string, query?: Record<string, unknown>) => {
			seen.push({ path, ...(query ? { query } : {}) });
			if (!jobs.some((j) => path === `/repos/o/r/actions/jobs/${j.id}/logs`)) {
				throw new Error(`log read with a wrong id: ${path}`);
			}
			if (log instanceof FgjError) throw log;
			return log;
		},
	};
	return {
		target: {
			baseUrl: "https://git.example.com",
			owner: "o",
			name: "r",
			repoFromFlag: false,
			hostSource: "origin",
		},
		api,
		commandFor: (
			words: string,
			args: readonly string[],
			flags: Record<string, string> = {},
		) =>
			[
				"fgj",
				words,
				...args,
				...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v]),
			].join(" "),
		seen,
	} as unknown as VerbContext<ReadApi> & { seen: typeof seen };
}

const local = { cwd: "/", home: undefined };
const args = (positionals: string[], flags: Record<string, unknown> = {}) =>
	({ positionals, flags }) as Parameters<typeof runGet.prepare>[0];

describe("run get and run log against synthetic logs", () => {
	test("run get 40 returns the status, the jobs, and the error block with ETIMEDOUT in one call", async () => {
		const ctx = fakeCtx(await fixture("failed-vitest-timeout"));
		const out = (await runGet.run(
			runGet.prepare(args(["40"]), local),
			ctx,
		)) as {
			number: number;
			jobs: unknown[];
			failure: { job: string; lines: string[] };
		};
		expect(out.number).toBe(40);
		expect(out.jobs).toEqual([{ name: "verify", status: "failure" }]);
		expect(out.failure.job).toBe("verify");
		expect(out.failure.lines).toContain("Error: spawnSync pi ETIMEDOUT");
		expect(JSON.stringify(out)).not.toContain("***");
		expect(JSON.stringify(out).length).toBeLessThan(6000);
	});

	test("a log that Forgejo no longer has reads as unavailable with its reason", async () => {
		const gone = new FgjError(
			"not_found",
			"Not found (HTTP 404) GET /repos/o/r/actions/jobs/124/logs: logs have expired",
			"fgj help",
		);
		const out = (await runGet.run(
			runGet.prepare(args(["40"]), local),
			fakeCtx(gone),
		)) as {
			failure: unknown;
		};
		expect(out.failure).toEqual({
			job: "verify",
			unavailable: "logs have expired",
		});
	});

	test("run log --match finds a text anywhere; --tail gives the last lines; the result names how the job ended", async () => {
		const ctx = fakeCtx(await fixture("failed-vitest-timeout"));
		const hit = (await runLog.run(
			runLog.prepare(args(["40"], { match: ["etimedout"] }), local),
			ctx,
		)) as { hits: number; lines: string[]; result: string };
		expect(hit.result).toBe("failure");
		expect(hit.hits).toBeGreaterThanOrEqual(2);
		expect(hit.lines.join("\n")).toContain("→ spawnSync pi ETIMEDOUT");
		const tail = (await runLog.run(
			runLog.prepare(args(["40"], { tail: 2 }), local),
			ctx,
		)) as { lines: string[] };
		expect(tail.lines).toEqual(["🏁  Job failed", "Job 'verify' failed"]);
	});

	test("run get names the other failed jobs in a hint", async () => {
		const ctx = fakeCtx(await fixture("failed-tsc"), [
			{ id: 127, name: "lint", status: "failure", task_id: 1, attempt: 1 },
			{ id: 125, name: "test", status: "failure", task_id: 2, attempt: 1 },
		]);
		const out = (await runGet.run(
			runGet.prepare(args(["40"]), local),
			ctx,
		)) as {
			failure: { job: string };
			hint: string;
		};
		expect(out.failure.job).toBe("lint");
		expect(out.hint).toBe("fgj read run log 40 --job test");
	});
});

describe("review fixes: run verbs", () => {
	test("a browser URL with /attempt/M reads the run, the job, and the attempt", () => {
		const input = runLog.prepare(
			args(["https://git.example.com/o/r/actions/runs/40/jobs/1/attempt/2"]),
			local,
		);
		expect(input.ref).toMatchObject({ kind: "number", number: 40, job: 1 });
		expect(input.attempt).toBe(2);
		expect(() => runLog.prepare(args(["40"], { attempt: 0 }), local)).toThrow(
			/attempt/,
		);
	});

	test("run log reports the job's API status, not a guess from the log text", async () => {
		const ctx = fakeCtx("step one\nstep two\n", [
			{ id: 127, name: "verify", status: "cancelled", task_id: 9, attempt: 1 },
		]);
		const out = (await runLog.run(
			runLog.prepare(args(["40"], { tail: 1 }), local),
			ctx,
		)) as { result: string };
		expect(out.result).toBe("cancelled");
	});

	test("--tail over the cap keeps the last lines and gives a smaller --tail as next", async () => {
		const long = Array.from(
			{ length: 500 },
			(_, i) => `${i} ${'"q" '.repeat(60)}`,
		);
		long.push("🏁  Job failed");
		const out = (await runLog.run(
			runLog.prepare(args(["40"], { tail: 500 }), local),
			fakeCtx(long.join("\n")),
		)) as { lines: string[]; next: string };
		expect(JSON.stringify(out).length).toBeLessThan(28_000);
		expect(out.lines.at(-1)).toBe("🏁  Job failed");
		expect(out.next).toMatch(/^fgj read run log 40 --tail \d+$/);
	});

	test("the error block finds the cause for cargo, eslint, pytest, docker, and npm", () => {
		const cases: [string[], string][] = [
			[
				[
					"   Compiling app v0.1.0",
					"error[E0308]: mismatched types",
					" --> src/main.rs:4:5",
					"error: could not compile `app`",
				],
				"error[E0308]: mismatched types",
			],
			[
				[
					"/w/src/a.ts",
					"  12:5  error  'x' is not defined  no-undef",
					"",
					"✖ 1 problem (1 error, 0 warnings)",
				],
				"  12:5  error  'x' is not defined  no-undef",
			],
			[
				[
					"tests/test_a.py:3: in test_a",
					"E       assert 1 == 2",
					"FAILED tests/test_a.py::test_a - assert 1 == 2",
				],
				"FAILED tests/test_a.py::test_a - assert 1 == 2",
			],
			[
				[
					"#7 [build 3/4] RUN make",
					"#7 1.2 make: *** No rule",
					"ERROR: failed to solve: process did not complete",
				],
				"ERROR: failed to solve: process did not complete",
			],
			[
				["npm ERR! code ELIFECYCLE", "npm ERR! errno 1"],
				"npm ERR! code ELIFECYCLE",
			],
		];
		for (const [body, cause] of cases) {
			const lines = [
				...Array(40).fill("noise"),
				...body,
				...Array(20).fill("more"),
				"⚙️ [runner]: exitcode '1': failure",
			];
			expect({ cause, found: errorBlock(lines).includes(cause) }).toEqual({
				cause,
				found: true,
			});
		}
	});

	test("a failed step before the last one does not hide the failure that ended the job", () => {
		const lines = [
			"FAIL tolerated.test.ts",
			"⚙️ [runner]: exitcode '1': failure",
			...Array(30).fill("next step"),
			"FAIL real.test.ts",
			"⚙️ [runner]: exitcode '1': failure",
			"🏁  Job failed",
		];
		expect(errorBlock(lines)).toContain("FAIL real.test.ts");
	});

	test("hints keep the run URL, and a job that never ran or a running run hints to check again", async () => {
		const url = "https://git.example.com/o/r/actions/runs/40";
		const ctx = fakeCtx(await fixture("failed-tsc"), [
			{ id: 127, name: "lint", status: "failure", task_id: 1, attempt: 1 },
			{ id: 125, name: "test", status: "failure", task_id: 2, attempt: 1 },
		]);
		const out = (await runGet.run(runGet.prepare(args([url]), local), ctx)) as {
			hint: string;
		};
		expect(out.hint).toBe(`fgj read run log ${url} --job test`);
		const never = new FgjError(
			"not_found",
			"Not found (HTTP 404) GET /repos/o/r/actions/jobs/124/logs: job has not been executed yet",
			"fgj help",
		);
		const waiting = (await runLog.run(
			runLog.prepare(args(["40"]), local),
			fakeCtx(never, [
				{ id: 127, name: "verify", status: "waiting", task_id: 0, attempt: 1 },
			]),
		)) as { hint: string };
		expect(waiting.hint).toBe("fgj read run get 40");
	});

	test("run get with /jobs/N reads that job's failure", async () => {
		const ctx = fakeCtx(await fixture("failed-tsc"), [
			{ id: 127, name: "lint", status: "failure", task_id: 1, attempt: 1 },
			{ id: 125, name: "test", status: "failure", task_id: 2, attempt: 1 },
		]);
		const out = (await runGet.run(
			runGet.prepare(args(["/o/r/actions/runs/40/jobs/1"]), local),
			ctx,
		)) as { failure: { job: string } };
		expect(out.failure.job).toBe("test");
	});

	test("credentials in a URL, OSC-8 links, and carriage-return progress are removed", () => {
		const lines = cleanLog(
			[
				"remote: https://oauth2:ghp_abc123def456@git.example.com/o/r.git",
				"see \x1b]8;;https://x.example\x07link\x1b]8;;\x07 here",
				"50%\r100% done",
			].join("\n"),
		);
		expect(lines.join("\n")).not.toContain("ghp_abc123def456");
		expect(lines[1]).toBe("see link here");
		expect(lines[2]).toBe("100% done");
	});

	test("--attempt reads that attempt of the job, and its result comes from the log", async () => {
		const ctx = fakeCtx(await fixture("failed-tsc"), [
			{ id: 126, name: "verify", status: "success", task_id: 3, attempt: 2 },
		]);
		const out = (await runLog.run(
			runLog.prepare(args(["40"], { attempt: 1, tail: 1 }), local),
			ctx,
		)) as { result: string };
		expect(out.result).toBe("failure");
		expect(ctx.seen.at(-1)).toEqual({
			path: "/repos/o/r/actions/jobs/126/logs",
			query: { attempt: 1 },
		});
	});
});

describe("review round 2 fixes: run verbs", () => {
	test("next after a --tail cut keeps the job that the URL named", async () => {
		const long = Array.from(
			{ length: 500 },
			(_, i) => `${i} ${'"q" '.repeat(60)}`,
		);
		const ctx = fakeCtx(long.join("\n"), [
			{ id: 127, name: "lint", status: "failure", task_id: 1, attempt: 1 },
			{ id: 128, name: "test", status: "failure", task_id: 2, attempt: 1 },
		]);
		const out = (await runLog.run(
			runLog.prepare(
				args(["/o/r/actions/runs/40/jobs/1"], { tail: 500 }),
				local,
			),
			ctx,
		)) as { job: string; next: string };
		expect(out.job).toBe("test");
		expect(out.next).toMatch(
			/^fgj read run log \/o\/r\/actions\/runs\/40 --job 1 --tail \d+$/,
		);
	});

	test("harmless error lines early in the log do not push the real failure out of the block", () => {
		const lines: string[] = [];
		for (let i = 0; i < 6; i++) {
			lines.push(
				...Array(15).fill("ok"),
				`Error: handled warning ${i}`,
				...Array(15).fill("ok"),
			);
		}
		lines.push(
			" FAIL  src/a.test.ts > adds",
			"AssertionError: expected 2 to be 3",
			" ❯ src/a.test.ts:4:5",
			...Array(30).fill("."),
			" Test Files  1 failed | 3 passed (4)",
			"⚙️ [runner]: exitcode '1': failure",
		);
		const block = errorBlock(lines);
		expect(block).toContain(" FAIL  src/a.test.ts > adds");
		expect(block).toContain("AssertionError: expected 2 to be 3");
		expect(block.at(-1)).toBe("⚙️ [runner]: exitcode '1': failure");
	});

	test("the exit line alone shows the 30 lines before it, even with an anchor far earlier", () => {
		const lines = [
			"Error: early and harmless",
			...Array(60).fill("filler"),
			...Array.from({ length: 20 }, (_, i) => `build step ${i}`),
			"⚙️ [runner]: exitcode '2': failure",
		];
		expect(errorBlock(lines)).toContain("build step 0");
	});

	test("run get on a job URL for a job that passed shows the failed job instead", async () => {
		const ctx = fakeCtx(await fixture("failed-tsc"), [
			{ id: 127, name: "build", status: "success", task_id: 1, attempt: 1 },
			{ id: 128, name: "test", status: "failure", task_id: 2, attempt: 1 },
		]);
		const out = (await runGet.run(
			runGet.prepare(args(["/o/r/actions/runs/40/jobs/0"]), local),
			ctx,
		)) as { failure: { job: string } };
		expect(out.failure.job).toBe("test");
	});

	test("a skipped job that never ran gets no hint to read the run again", async () => {
		const never = new FgjError(
			"not_found",
			"Not found (HTTP 404) GET /repos/o/r/actions/jobs/127/logs: job has not been executed yet",
			"fgj help",
		);
		const out = (await runLog.run(
			runLog.prepare(args(["40"]), local),
			fakeCtx(never, [
				{ id: 127, name: "deploy", status: "skipped", task_id: 0, attempt: 1 },
			]),
		)) as Record<string, unknown>;
		expect(out.unavailable).toBe("job has not been executed yet");
		expect(out.hint).toBeUndefined();
	});

	test("an error line shortly before the exit line keeps every line between them", () => {
		const lines = [
			...Array(40).fill("setup"),
			"error: minor",
			...Array.from({ length: 22 }, (_, i) => `out ${i}`),
			"⚙️ [runner]: exitcode '1': failure",
		];
		const block = errorBlock(lines);
		for (let i = 0; i < 22; i++) expect(block).toContain(`out ${i}`);
	});

	test("a block that dropped earlier parts starts with the gap line", () => {
		const lines: string[] = [];
		for (let i = 0; i < 40; i++)
			lines.push(`FAIL t${i}`, ...Array(12).fill("."));
		lines.push("⚙️ [runner]: exitcode '1': failure");
		const block = errorBlock(lines, 30);
		expect(block[0]).toBe(GAP);
		expect(block.length).toBeLessThanOrEqual(30);
	});

	test("run get reads the attempt of a job URL when that job failed", async () => {
		const ctx = fakeCtx(await fixture("failed-tsc"), [
			{ id: 126, name: "verify", status: "failure", task_id: 3, attempt: 2 },
		]);
		await runGet.run(
			runGet.prepare(args(["/o/r/actions/runs/40/jobs/0/attempt/1"]), local),
			ctx,
		);
		expect(ctx.seen.at(-1)).toEqual({
			path: "/repos/o/r/actions/jobs/126/logs",
			query: { attempt: 1 },
		});
	});
});

type Job = { name: string; needs?: string[] | null };
const jobs = (...list: Job[]) =>
	list.map((j, i) => ({
		id: i + 1,
		status: "success",
		task_id: 1,
		attempt: 1,
		...j,
	}));

describe("rerunPlan", () => {
	test("a job and every job that needs it, with no plus when the rest need nothing", () => {
		const all = jobs(
			{ name: "build" },
			{ name: "test", needs: ["build"] },
			{ name: "deploy", needs: ["test"] },
			{ name: "lint" },
		);
		expect(rerunPlan(all, all[0] as (typeof all)[0])).toEqual({
			jobs: ["build", "test", "deploy"],
		});
	});

	test("a name that equals another job's key never hides a job: it goes to plus", () => {
		// YAML: test (name: unit), lint (name: test), deploy (needs: [test]).
		// Forgejo re-runs unit and deploy for --job unit; the names cannot show it.
		const all = jobs(
			{ name: "unit" },
			{ name: "test" },
			{ name: "deploy", needs: ["test"] },
		);
		expect(rerunPlan(all, all[0] as (typeof all)[0])).toEqual({
			jobs: ["unit"],
			plus: ["deploy"],
		});
	});
});

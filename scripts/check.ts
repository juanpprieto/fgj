#!/usr/bin/env bun
/**
 * Runs every check and prints one JSON line per step, for agents and humans:
 * the test server, lint, typecheck, the docs check, and tests. A failed step
 * includes its output, cut to the first lines. When tests fail, a server-log line lists the server log
 * problems from this run. The tests run with their own empty TMPDIR, which fgj
 * child processes inherit; a file left there fails the check with a leak line.
 *
 * Every step runs, even after a failure, so one call shows the whole state.
 * Usage: bun scripts/check.ts
 */
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import {
	containerName,
	isProblem,
	parseLog,
	readServerLog,
} from "./forgejo-logs.ts";

const MAX_LINES = 80;

/** One check step: a name, the command, and an optional env and fix hint. */
export interface Step {
	name: string;
	cmd: string[];
	/** A command that fixes the failure, when `fixes` matches every error line. */
	fix?: string;
	fixes?: RegExp;
	env?: Record<string, string>;
}

// Tools keep these in TMPDIR on purpose and reuse them; they are not fgj leaks.
// Node writes its compile cache when a test runs Codex or tsc. Podman writes its
// run root (containers/storage) when a failed test reads the server log.
const TOOL_CACHES = /^(node-compile-cache|storage-run-\d+)$/;

/**
 * The test files that run at once: FGJ_TEST_WORKERS, else two fewer than the
 * CPUs, from 1 to 4. One test Forgejo serves every file, and its SQLite store
 * takes one write at a time: with 8 files, write-heavy tests ran 2 to 3 times
 * slower and some passed the 5 s test limit; with 4, the whole run took 72 s
 * instead of 56 s, and none came near it.
 */
function workers(): number {
	const set = Number(process.env.FGJ_TEST_WORKERS);
	if (Number.isInteger(set) && set >= 1) return set;
	return Math.min(4, Math.max(1, availableParallelism() - 2));
}

function steps(testTmp: string): Step[] {
	return [
		{ name: "server", cmd: ["bun", "scripts/forgejo-test-server.ts", "start"] },
		{
			name: "lint",
			cmd: ["./node_modules/.bin/biome", "check", "--reporter=concise", "."],
			fix: "bun run format",
			fixes: /: format:/,
		},
		{
			name: "typecheck",
			cmd: ["./node_modules/.bin/tsc", "--noEmit", "--pretty", "false"],
		},
		{ name: "docs", cmd: ["bun", "scripts/docs-check.ts"] },
		{
			name: "test",
			// Several files at a time: each test file uses its own repositories.
			// FGJ_TEST_WORKERS sets the count, for a machine with fewer CPUs.
			cmd: ["bun", "test", "--only-failures", `--parallel=${workers()}`],
			env: { TMPDIR: testTmp },
		},
	];
}

// Strip ANSI color codes so the output reads the same in any harness.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function trimOutput(text: string): { out: string; cut?: number } {
	const lines = text
		.replace(ANSI, "")
		.split("\n")
		.filter((l) => l.trim());
	if (lines.length <= MAX_LINES) return { out: lines.join("\n") };
	return {
		out: lines.slice(0, MAX_LINES).join("\n"),
		cut: lines.length - MAX_LINES,
	};
}

/**
 * Runs one check step and describes the result as one JSON-ready line.
 *
 * @param step - The step name, its command, and an optional env and fix hint.
 * @returns The line: `step`, `ok`, and `ms`. On failure it adds `out`, `code` when
 *   the process ran, `cut` (the number of lines left out) when the output is too
 *   long, and `fix` when the step's fix command can fix every error.
 * @example
 * const line = await runStep({ name: "lint", cmd: ["biome", "check", "."] });
 */
export async function runStep(step: Step): Promise<Record<string, unknown>> {
	const t0 = performance.now();
	// The output goes to files, not pipes: a child that a test leaves behind can
	// hold a pipe open after the command exits, and a read would never end.
	const logs = mkdtempSync(join(tmpdir(), "fgj-step-"));
	const outFile = join(logs, "out");
	const errFile = join(logs, "err");
	try {
		let proc: Bun.Subprocess;
		try {
			proc = Bun.spawn(step.cmd, {
				stdout: Bun.file(outFile),
				stderr: Bun.file(errFile),
				env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...step.env },
			});
		} catch (err) {
			// A missing command is a failed step, so the other steps still run.
			return {
				step: step.name,
				ok: false,
				ms: Math.round(performance.now() - t0),
				out: err instanceof Error ? err.message : String(err),
			};
		}
		const code = await proc.exited;
		const read = (file: string) =>
			existsSync(file) ? readFileSync(file, "utf8") : "";
		const [out, err] = [read(outFile), read(errFile)];
		// In CI, the failure lines come first as plain lines that a log reader keeps whole.
		if (code !== 0 && process.env.CI) {
			for (const line of failLines(`${out}\n${err}`)) console.log(line);
		}
		return stepLine(step, code, out, err, t0);
	} finally {
		rmSync(logs, { recursive: true, force: true });
	}
}

/** The most failure lines that a CI log gets for one step. */
const FAIL_LINES_MAX = 60;

/**
 * Picks the lines that name a failure from a step's whole output: failed test
 * names, error lines, and timeout notes. In CI, fgj prints them as plain lines,
 * because a log reader cuts the long JSON line before the test names.
 *
 * @param text - The step's whole output.
 * @returns At most 60 lines, with no ANSI color codes.
 * @example
 * failLines("(pass) a\n(fail) b [3ms]"); // ["(fail) b [3ms]"]
 */
export function failLines(text: string): string[] {
	return text
		.replace(ANSI, "")
		.split("\n")
		.filter((l) => /^\(fail\) |^error: |^\s*\^ this test timed out/.test(l))
		.slice(0, FAIL_LINES_MAX);
}

/** Turns one finished step into its JSON-ready line. */
function stepLine(
	step: Step,
	code: number,
	out: string,
	err: string,
	t0: number,
): Record<string, unknown> {
	const ok = code === 0;
	const line: Record<string, unknown> = {
		step: step.name,
		ok,
		ms: Math.round(performance.now() - t0),
	};
	if (!ok) {
		const text = `${out}\n${err}`;
		const errors = text
			.split("\n")
			.filter((l) => l.startsWith("×") && l.includes(":"));
		const fixable =
			step.fix !== undefined &&
			errors.length > 0 &&
			errors.every((l) => step.fixes?.test(l));
		Object.assign(line, { code }, fixable ? { fix: step.fix } : {});
		Object.assign(line, trimOutput(text));
	}
	return line;
}

/**
 * Compares the Bun that runs the check with the pinned Bun. Another Bun fails
 * tests that pass on the pinned one, so the check stops before any step.
 *
 * @param running - The version of the Bun that runs the check.
 * @param pinned - The pinned version, from `@types/bun` in package.json.
 * @returns The failed `bun` step line, or `undefined` when the versions match.
 * @example
 * bunLine("1.4.2", "1.3.14"); // { step: "bun", ok: false, out: "…", fix: "mise exec -- bun run check" }
 */
export function bunLine(
	running: string,
	pinned: string,
): Record<string, unknown> | undefined {
	if (running === pinned) return undefined;
	return {
		step: "bun",
		ok: false,
		out: `Bun ${running} runs this check; the repository pins Bun ${pinned}. Run the check with Bun ${pinned}: mise.toml pins it, and mise exec runs it.`,
		fix: "mise exec -- bun run check",
	};
}

function prepareLocal(): string {
	for (const tool of ["bun", "git", "node", "npm", "codex", "pi"]) {
		if (!Bun.which(tool))
			throw new Error(
				`Install ${tool} before the complete contributor check. See CONTRIBUTING.md.`,
			);
	}
	if (
		!existsSync("node_modules/.bin/biome") ||
		!existsSync("node_modules/.bin/tsc")
	) {
		throw new Error(
			"Run bun install --frozen-lockfile before the contributor check.",
		);
	}
	if (existsSync(".forgejo-test/server.json"))
		throw new Error(
			"A test fixture already exists in this checkout. Use a separate checkout.",
		);
	const requested = process.env.FGJ_FORGEJO_PORT;
	if (
		requested &&
		(!/^\d+$/.test(requested) ||
			Number(requested) < 1 ||
			Number(requested) > 65535 ||
			Number(requested) === 3917)
	) {
		throw new Error("Choose a fixture port from 1 to 65535 other than 3917.");
	}
	let port: number;
	try {
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: requested ? Number(requested) : 0,
			socket: { data() {} },
		});
		port = listener.port;
		listener.stop();
	} catch {
		throw new Error(
			"The requested fixture port is busy. Choose an unused FGJ_FORGEJO_PORT.",
		);
	}
	if (port === 3917) return prepareLocal();
	const mode =
		process.env.FGJ_FORGEJO_MODE ??
		(process.platform === "linux" ? "binary" : "podman");
	if (mode !== "binary" && mode !== "podman")
		throw new Error("FGJ_FORGEJO_MODE must be binary or podman.");
	if (mode === "podman") {
		if (!Bun.which("podman"))
			throw new Error("Install and start Podman before the contributor check.");
		const existing = Bun.spawnSync([
			"podman",
			"container",
			"exists",
			containerName(String(port)),
		]);
		if (existing.exitCode !== 1)
			throw new Error(
				"The fixture container exists or Podman is unavailable. No service was changed.",
			);
	}
	mkdirSync(".forgejo-test", { recursive: true });
	const lock = ".forgejo-test/local-check.lock";
	try {
		closeSync(openSync(lock, "wx", 0o600));
	} catch {
		throw new Error(
			"Another contributor check owns this checkout. Use a separate checkout.",
		);
	}
	process.env.FGJ_FORGEJO_PORT = String(port);
	process.env.CI = "1";
	return lock;
}

async function main(): Promise<boolean> {
	const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
		devDependencies: Record<string, string>;
		version: string;
	};
	const wrongBun = bunLine(
		Bun.version,
		pkg.devDependencies["@types/bun"] ?? "",
	);
	if (wrongBun) {
		console.log(JSON.stringify(wrongBun));
		return false;
	}
	const local = process.argv.includes("--local");
	let lock: string | undefined;
	if (local) {
		try {
			lock = prepareLocal();
		} catch (error) {
			console.log(
				JSON.stringify({
					step: "prerequisites",
					ok: false,
					out:
						error instanceof Error
							? error.message
							: "Contributor prerequisites failed.",
				}),
			);
			return false;
		}
		process.env.FGJ_PACKAGE_TARBALL = join(
			process.cwd(),
			"dist",
			`fgj-${pkg.version}.tgz`,
		);
	}
	const testTmp = mkdtempSync(join(tmpdir(), "fgj-check-"));
	const startedAt = new Date().toISOString();
	let allOk = true;
	let ownsFixture = false;
	const pipeline = steps(testTmp);
	if (local)
		pipeline.splice(1, 0, {
			name: "package",
			cmd: ["bun", "scripts/package.ts"],
		});
	try {
		for (const step of pipeline) {
			if (local && step.name === "server") ownsFixture = true;
			const line = await runStep(step);
			allOk &&= line.ok === true;
			console.log(JSON.stringify(line));
			if (!line.ok && step.name === "test") {
				const problems = parseLog(await readServerLog(startedAt)).filter(
					isProblem,
				);
				if (problems.length > 0) {
					console.log(JSON.stringify({ step: "server-log", problems }));
				}
			}
			if (step.name === "test") {
				const left = readdirSync(testTmp).filter((f) => !TOOL_CACHES.test(f));
				if (left.length > 0) {
					allOk = false;
					console.log(
						JSON.stringify({
							step: "leak",
							ok: false,
							count: left.length,
							paths: left.slice(0, 20),
							hint: "A test or fgj left these in TMPDIR. Remove each one in the code that makes it.",
						}),
					);
				}
			}
			if (
				local &&
				!line.ok &&
				(step.name === "server" || step.name === "package")
			)
				break;
		}
	} finally {
		if (ownsFixture) {
			const stopped = await runStep({
				name: "cleanup",
				cmd: ["bun", "scripts/forgejo-test-server.ts", "stop"],
			});
			allOk &&= stopped.ok === true;
			console.log(JSON.stringify(stopped));
		}
		if (lock) rmSync(lock, { force: true });
		rmSync(testTmp, { recursive: true, force: true });
	}
	return allOk;
}

if (import.meta.main) {
	const started = performance.now();
	const allOk = await main();
	console.log(
		JSON.stringify({ ok: allOk, ms: Math.round(performance.now() - started) }),
	);
	process.exit(allOk ? 0 : 1);
}

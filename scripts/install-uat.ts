#!/usr/bin/env bun
/**
 * Prepares this machine for a UAT run of the current commit, in one command.
 *
 * 1. Builds and installs fgj with `install-local.ts`, and checks that the
 *    installed version names the current commit.
 * 2. Runs `fgj rules install <harness>` and `fgj skill install <harness>` only
 *    for the harnesses whose rules or skill are not current.
 *
 * Each install shows its diff and asks `[y/N]`. fgj reads that answer from the
 * terminal, so an agent cannot grant itself permissions: a human runs this
 * script and answers. It prints one JSON line at the end.
 *
 * Usage: bun scripts/install-uat.ts
 */
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** One harness row of `fgj rules status` or `fgj skill status`. */
interface HarnessState {
	harness: string;
	state: string;
}

/**
 * Lists the harnesses that need an install: every one that is not current.
 *
 * @param status - The parsed output of `fgj rules status` or `fgj skill status`.
 * @returns The harness names, in the order that status lists them.
 * @example
 * pending({ harnesses: [{ harness: "pi", state: "outdated" }] }); // ["pi"]
 */
export function pending(status: { harnesses: HarnessState[] }): string[] {
	return status.harnesses
		.filter((h) => h.state !== "current")
		.map((h) => h.harness);
}

function fail(message: string): never {
	console.error(JSON.stringify({ error: message }));
	process.exit(1);
}

function run(cmd: string[]): string {
	const proc = Bun.spawnSync(cmd, {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		fail(`${cmd.join(" ")} failed: ${proc.stderr.toString().trim()}`);
	}
	return proc.stdout.toString();
}

function status(bin: string, kind: "rules" | "skill"): HarnessState[] {
	return (
		JSON.parse(run([bin, kind, "status"])) as { harnesses: HarnessState[] }
	).harnesses;
}

if (import.meta.main) {
	const installed = JSON.parse(
		run(["bun", resolve(ROOT, "scripts", "install-local.ts")]),
	) as { installed: string; version: string; previous?: string };
	const head = run(["git", "rev-parse", "--short", "HEAD"]).trim();
	if (!installed.version.endsWith(`+${head}`)) {
		fail(
			`Installed ${installed.version}, but HEAD is ${head}. Check the build.`,
		);
	}
	const bin = installed.installed;
	for (const kind of ["rules", "skill"] as const) {
		const todo = pending({ harnesses: status(bin, kind) });
		if (todo.length > 0 && !process.stdin.isTTY) {
			fail(
				`fgj ${kind} install needs a human at a terminal for: ${todo.join(", ")}. Run this script in your own terminal.`,
			);
		}
		for (const harness of todo) {
			console.error(`\n== fgj ${kind} install ${harness}`);
			// The child reads the [y/N] answer from this terminal.
			const proc = Bun.spawnSync([bin, kind, "install", harness], {
				cwd: ROOT,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			if (proc.exitCode !== 0) {
				fail(`fgj ${kind} install ${harness} exited ${proc.exitCode}.`);
			}
		}
	}
	const rules = status(bin, "rules");
	const skill = status(bin, "skill");
	const summary = (rows: HarnessState[]) =>
		Object.fromEntries(rows.map((r) => [r.harness, r.state]));
	console.log(
		JSON.stringify({
			version: installed.version,
			...(installed.previous ? { previous: installed.previous } : {}),
			rules: summary(rules),
			skill: summary(skill),
		}),
	);
	if (pending({ harnesses: [...rules, ...skill] }).length > 0) process.exit(1);
}

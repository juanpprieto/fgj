import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
	chmod,
	mkdir,
	realpath,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Io } from "../core/dispatch.ts";
import { EXIT, FgjError } from "../core/errors.ts";
import { toLine } from "../core/output.ts";

/** The harnesses fgj installs into. */
export const HARNESSES = ["codex", "claude", "pi"] as const;

/** One supported harness. */
export type Harness = (typeof HARNESSES)[number];

type Env = Record<string, string | undefined>;

/**
 * Finds a harness's config directory. Each harness's own env var moves it.
 *
 * @param harness - The harness.
 * @param env - The process env: `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `HOME`.
 * @returns The absolute directory.
 * @example
 * harnessDir("pi", { HOME: "/Users/a" }); // "/Users/a/.pi/agent"
 */
export function harnessDir(harness: Harness, env: Env): string {
	const home = env.HOME ?? "";
	if (harness === "codex") return env.CODEX_HOME || join(home, ".codex");
	if (harness === "claude")
		return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
	return env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
}

/**
 * Reads a harness name from argv.
 *
 * @param raw - The argument.
 * @param hint - The help command for the error.
 * @returns The harness.
 * @throws {FgjError} A usage error that lists the harnesses.
 * @example
 * harnessArg("codex", "fgj help rules"); // "codex"
 */
export function harnessArg(raw: string | undefined, hint: string): Harness {
	if (raw && (HARNESSES as readonly string[]).includes(raw)) {
		return raw as Harness;
	}
	throw new FgjError(
		"usage",
		`Expected a harness: ${HARNESSES.join(", ")}. Got "${raw ?? ""}".`,
		hint,
	);
}

/**
 * Reads a file, or gives undefined when it does not exist.
 *
 * @param path - The file.
 * @returns The text, or undefined.
 * @example
 * await readIfExists("/tmp/none"); // undefined
 */
export async function readIfExists(path: string): Promise<string | undefined> {
	const file = Bun.file(path);
	return (await file.exists()) ? file.text() : undefined;
}

/** A unified diff from git, with the temp paths replaced by the real file. */
function unifiedDiff(before: string, after: string, label: string): string {
	const dir = mkdtempSync(join(tmpdir(), "fgj-diff-"));
	const a = join(dir, "a");
	const b = join(dir, "b");
	let out: string;
	try {
		// Synchronous writes: git must see both files before it runs.
		writeFileSync(a, before);
		writeFileSync(b, after);
		const proc = Bun.spawnSync(
			["git", "diff", "--no-index", "--no-color", "-U2", "--", a, b],
			{ stdout: "pipe", stderr: "pipe" },
		);
		out = proc.stdout.toString();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	if (!out) {
		return after
			.split("\n")
			.map((l) => `+${l}`)
			.join("\n");
	}
	return out.replaceAll(a, label).replaceAll(b, label);
}

/** The real file behind a path: a dotfiles symlink stays a symlink after a write. */
async function realTarget(path: string): Promise<string> {
	return realpath(path).catch(() => path);
}

async function writeAtomic(path: string, text: string): Promise<void> {
	const target = await realTarget(path);
	const existing = await stat(target).catch(() => undefined);
	const mode = existing ? existing.mode & 0o777 : 0o644;
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.fgj-${process.pid}.tmp`;
	// Create the temp file with its final mode, so the text is never more open.
	await writeFile(temp, text, { mode });
	await chmod(temp, mode);
	await rename(temp, target);
}

/** What one install changes, and what a human may see of it. */
export interface InstallPlan {
	harness: Harness;
	file: string;
	before: string | undefined;
	after: string;
	/** The text the diff shows. It hides parts of the file that can hold secrets. */
	shown: (text: string | undefined) => string;
	/** Keep a copy of the old file first. */
	backup?: boolean;
}

/**
 * Applies one harness file change with a human's consent: it shows a diff, asks
 * `[y/N]`, and writes atomically, keeping the file mode. An agent cannot run it,
 * because it must never grant itself permissions or change its own instructions.
 *
 * @param io - The process surface. `io.prompt` must exist.
 * @param plan - The file, the old and new text, and what the diff may show.
 * @param what - A short name for the change, for the error, for example `fgj rules install`.
 * @returns The exit code. stdout gets `{changed, harness, file}` and, with a backup, `backup`.
 * @throws {FgjError} A usage error when no human is at a terminal.
 * @example
 * await installWithConsent(io, plan, "fgj skill install");
 */
export async function installWithConsent(
	io: Io,
	plan: InstallPlan,
	what: string,
): Promise<number> {
	const prompt = io.prompt;
	if (!prompt) {
		throw new FgjError(
			"usage",
			`${what} changes what agents in ${plan.harness} may do. A human must run it at a terminal; an agent must not change its own permissions or instructions.`,
			"fgj help",
		);
	}
	const { harness, file, before, after } = plan;
	if (before === after) {
		io.stdout(toLine({ changed: false, harness, file }));
		return EXIT.ok;
	}
	io.stderr(`${unifiedDiff(plan.shown(before), plan.shown(after), file)}\n`);
	const answer = (await prompt(`Apply these changes to ${file}? [y/N] `, false))
		.trim()
		.toLowerCase();
	if (answer !== "y" && answer !== "yes") {
		io.stdout(toLine({ changed: false, harness, file, declined: true }));
		return EXIT.ok;
	}
	let backup: string | undefined;
	if (plan.backup && before !== undefined) {
		const target = await realTarget(file);
		backup = `${target}.fgj-backup`;
		// Keep the first backup: it is the file as it was before fgj touched it.
		if (!(await Bun.file(backup).exists())) {
			const mode = (await stat(target)).mode & 0o777;
			await writeFile(backup, before, { mode });
			await chmod(backup, mode);
		}
	}
	await writeAtomic(file, after);
	io.stdout(
		toLine({ changed: true, harness, file, ...(backup ? { backup } : {}) }),
	);
	return EXIT.ok;
}

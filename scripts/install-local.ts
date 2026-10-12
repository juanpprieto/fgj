#!/usr/bin/env bun
/**
 * Builds fgj and copies it to ~/.local/bin/fgj (or FGJ_INSTALL_DIR). Agents keep
 * the installed copy until the next install, so a branch build never goes live
 * by accident.
 *
 * - It refuses a build from a changed work tree unless you pass --dirty.
 * - It refuses to replace a file there that is not an fgj binary.
 *
 * Usage: bun scripts/install-local.ts [--dirty]
 */
import { rmSync } from "node:fs";
import { chmod, rename } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const dir = process.env.FGJ_INSTALL_DIR || join(homedir(), ".local", "bin");
const target = join(dir, "fgj");
const allowDirty = process.argv.includes("--dirty");

function fail(message: string): never {
	console.error(JSON.stringify({ error: message }));
	process.exit(1);
}

function versionOf(bin: string): string | undefined {
	const proc = Bun.spawnSync([bin, "--version"], { stdout: "pipe" });
	try {
		return (JSON.parse(proc.stdout.toString()) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

// Check the tree before a full build, so a refusal costs nothing.
const dirtyTree =
	Bun.spawnSync(["git", "status", "--porcelain"], { cwd: ROOT })
		.stdout.toString()
		.trim() !== "";
if (dirtyTree && !allowDirty) {
	fail("The work tree has changes. Commit first, or pass --dirty.");
}

const staged = join(tmpdir(), `fgj-install-${process.pid}`);
process.on("exit", () => {
	// Remove the staged build on every path, a refusal included.
	try {
		rmSync(staged, { force: true });
	} catch {
		// Nothing to clean.
	}
});
const build = Bun.spawnSync(
	["bun", join(ROOT, "scripts", "build.ts"), "--outfile", staged],
	{ stdout: "pipe", stderr: "pipe" },
);
if (build.exitCode !== 0) fail(`build failed: ${build.stderr.toString()}`);
const { version } = JSON.parse(build.stdout.toString()) as { version: string };
if (version.endsWith("-dirty") && !allowDirty) {
	fail(
		`The work tree has changes (${version}). Commit first, or pass --dirty.`,
	);
}

let previous: string | undefined;
if (await Bun.file(target).exists()) {
	previous = versionOf(target);
	if (previous === undefined) {
		fail(`${target} exists and is not an fgj binary. Move it away first.`);
	}
}

// Copy next to the target, then rename, so a running agent never sees half a file.
const temp = join(dir, `.fgj-${process.pid}.tmp`);
await Bun.write(temp, Bun.file(staged));
await chmod(temp, 0o755);
await rename(temp, target);
console.log(
	JSON.stringify({
		installed: target,
		version: versionOf(target),
		...(previous ? { previous } : {}),
	}),
);

#!/usr/bin/env bun
/**
 * Builds the fgj binary with its version stamped in: `<package version>+<git sha>`,
 * with `-dirty` when the work tree has changes. It prints one JSON line.
 *
 * Usage: bun scripts/build.ts [--bundle] [--release] [--outfile PATH] [--target bun-linux-x64 ...]
 */
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.includes("--release")) {
	const guard = Bun.spawnSync(
		[process.execPath, join(ROOT, "scripts/release-check.ts")],
		{
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (guard.exitCode !== 0) {
		console.error(guard.stderr.toString().trim());
		process.exit(guard.exitCode ?? 1);
	}
}
const flag = (name: string) => {
	const at = args.indexOf(name);
	if (at < 0) return undefined;
	const value = args[at + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`Build arguments: ${name} needs a value.`);
	return value;
};
const bundle = args.includes("--bundle");
if (bundle && args.includes("--target"))
	throw new Error("Build arguments: --bundle cannot use a native --target.");
const outfile = resolve(
	flag("--outfile") ?? join(ROOT, "dist", bundle ? "cli.js" : "fgj"),
);
const target = flag("--target");

const git = (...cmd: string[]) =>
	Bun.spawnSync(["git", ...cmd], { cwd: ROOT })
		.stdout.toString()
		.trim();
const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
	version: string;
};
const sha = git("rev-parse", "--short", "HEAD") || "unknown";
const dirty = git("status", "--porcelain") ? "-dirty" : "";
const version = `${pkg.version}+${sha}${dirty}`;

const build = Bun.spawnSync(
	[
		"bun",
		"build",
		join(ROOT, "src", "cli.ts"),
		...(bundle
			? ["--target=bun"]
			: [
					"--compile",
					"--no-compile-autoload-dotenv",
					"--no-compile-autoload-bunfig",
				]),
		"--define",
		`FGJ_VERSION=${JSON.stringify(version)}`,
		"--define",
		`FGJ_STANDALONE=${!bundle}`,
		...(target && !bundle ? ["--target", target] : []),
		"--outfile",
		outfile,
	],
	{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
);
if (build.exitCode !== 0) {
	console.error(build.stderr.toString());
	process.exit(build.exitCode ?? 1);
}
// Compilation changes the Mach-O bytes after Bun's linker signature. Sign the final bytes locally.
if (
	!bundle &&
	process.platform === "darwin" &&
	(!target || target.startsWith("bun-darwin"))
) {
	for (const argv of [
		["/usr/bin/codesign", "--force", "--sign", "-", outfile],
		["/usr/bin/codesign", "--verify", "--strict", outfile],
	]) {
		const signed = Bun.spawnSync(argv, {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (signed.exitCode !== 0) {
			console.error(signed.stderr.toString().trim());
			process.exit(signed.exitCode ?? 1);
		}
	}
}
console.log(
	JSON.stringify({ outfile, version, bytes: Bun.file(outfile).size }),
);

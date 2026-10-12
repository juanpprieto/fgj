#!/usr/bin/env bun
/** Builds a script-free npm archive. Usage: bun run package [--release] */
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT = join(ROOT, "dist");

function run(argv: string[], cwd: string, env = process.env): string {
	const result = Bun.spawnSync(argv, {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(result.stderr.toString() || `${argv[0]} failed`);
	return result.stdout.toString();
}

async function pack(): Promise<void> {
	const release = process.argv.slice(2).includes("--release");
	if (release)
		run([process.execPath, join(ROOT, "scripts/release-check.ts")], ROOT);
	const pkg: unknown = await Bun.file(join(ROOT, "package.json")).json();
	if (
		!pkg ||
		typeof pkg !== "object" ||
		!("name" in pkg) ||
		pkg.name !== "fgj" ||
		!("version" in pkg) ||
		typeof pkg.version !== "string" ||
		!/^[0-9][0-9A-Za-z.+-]*$/.test(pkg.version) ||
		!Bun.semver.satisfies(pkg.version, pkg.version) ||
		!("license" in pkg) ||
		pkg.license !== "MIT OR Apache-2.0"
	)
		throw new Error(
			"Expected fgj metadata with a valid version and both licenses.",
		);
	const filename = `${pkg.name}-${pkg.version}.tgz`;
	let repository: { type: "git"; url: string } | undefined;
	if ("repository" in pkg) {
		const value = pkg.repository;
		if (
			!value ||
			typeof value !== "object" ||
			!("type" in value) ||
			value.type !== "git" ||
			!("url" in value) ||
			typeof value.url !== "string" ||
			Object.keys(value).length !== 2 ||
			/\s/.test(value.url) ||
			!/^git\+https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.git$/.test(
				value.url,
			)
		)
			throw new Error(
				"Expected public GitHub repository metadata without extra fields.",
			);
		repository = { type: "git", url: value.url };
	}
	const manifest = {
		name: pkg.name,
		version: pkg.version,
		description: "Forgejo command-line interface for LLM agents",
		license: pkg.license,
		type: "module",
		bin: { fgj: "cli.js" },
		engines: { bun: "1.3.14" },
		os: ["darwin", "linux"],
		cpu: ["arm64"],
		...(repository ? { repository } : {}),
	};
	mkdirSync(OUTPUT, { recursive: true });
	const scratch = mkdtempSync(join(OUTPUT, ".package-"));
	const stage = join(scratch, "package");
	try {
		mkdirSync(stage);
		run(
			[
				process.execPath,
				join(ROOT, "scripts/build.ts"),
				"--bundle",
				...(release ? ["--release"] : []),
				"--outfile",
				join(stage, "cli.js"),
			],
			ROOT,
		);
		const bundle = readFileSync(join(stage, "cli.js"), "utf8");
		if (
			!bundle.startsWith(
				"#!/usr/bin/env -S bun --no-env-file --config=/dev/null\n",
			) ||
			!bundle.includes(`${pkg.version}+`)
		)
			throw new Error("The candidate bundle is absent or invalid.");
		chmodSync(join(stage, "cli.js"), 0o755);
		for (const file of ["LICENSE-MIT", "LICENSE-APACHE"]) {
			const text = readFileSync(join(ROOT, file), "utf8");
			const required =
				file === "LICENSE-MIT"
					? [
							"MIT License",
							"Copyright",
							"Permission is hereby granted, free of charge",
						]
					: [
							"Apache License",
							"Version 2.0, January 2004",
							"TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
						];
			if (!required.every((part) => text.includes(part)))
				throw new Error(`${file} is empty or corrupt.`);
			await Bun.write(join(stage, file), text);
		}
		await Bun.write(
			join(stage, "package.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		const gettingStarted = readFileSync(join(ROOT, "README.md"), "utf8")
			.split("<!-- getting-started:start -->")[1]
			?.split("<!-- getting-started:end -->")[0]
			?.trim();
		if (!gettingStarted)
			throw new Error("README.md needs the tested getting-started section.");
		const guide = gettingStarted.replace(/fgj-[0-9A-Za-z.+-]+\.tgz/g, filename);
		await Bun.write(
			join(stage, "README.md"),
			`# fgj\n\nForgejo command-line interface for LLM agents.\n\n${guide}\n\nRun fgj help auth, fgj help rules and fgj help skill for additional setup.\n\nLicensed under MIT OR Apache-2.0. Both license texts are included.\n`,
		);
		const packed: unknown = JSON.parse(
			run(
				[
					"npm",
					"pack",
					"--ignore-scripts",
					"--json",
					"--pack-destination",
					scratch,
				],
				stage,
				{
					PATH: process.env.PATH ?? "",
					HOME: scratch,
					TMPDIR: tmpdir(),
					npm_config_cache: join(scratch, "cache"),
					npm_config_userconfig: join(scratch, "npmrc"),
					npm_config_globalconfig: join(scratch, "global-npmrc"),
					npm_config_update_notifier: "false",
				},
			),
		);
		if (
			!Array.isArray(packed) ||
			packed.length !== 1 ||
			packed[0]?.filename !== filename ||
			!Array.isArray(packed[0].files)
		)
			throw new Error("npm returned an unexpected archive.");
		const archive = packed[0];
		const inventory = archive.files
			.map((file: unknown) => {
				if (
					!file ||
					typeof file !== "object" ||
					!("path" in file) ||
					typeof file.path !== "string"
				)
					throw new Error("npm returned an invalid inventory.");
				return file.path;
			})
			.sort();
		if (
			JSON.stringify(inventory) !==
			JSON.stringify([
				"LICENSE-APACHE",
				"LICENSE-MIT",
				"README.md",
				"cli.js",
				"package.json",
			])
		)
			throw new Error("npm included unexpected files.");
		const stagedArchive = join(scratch, archive.filename);
		const sha256 = createHash("sha256")
			.update(readFileSync(stagedArchive))
			.digest("hex");
		if (release)
			run(
				[
					process.execPath,
					join(ROOT, "scripts/release-check.ts"),
					"--archive",
					stagedArchive,
					"--sha256",
					sha256,
				],
				ROOT,
			);
		const tarball = join(OUTPUT, archive.filename);
		renameSync(stagedArchive, tarball);
		console.log(
			JSON.stringify({
				tarball,
				sha256,
				inventory,
			}),
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

pack().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Package failed.");
	process.exit(1);
});

#!/usr/bin/env bun
/** Builds and checks a local native candidate. It never uploads or publishes it. */
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const INVENTORY = [
	"BUN-LICENSE.md",
	"LICENSE-APACHE",
	"LICENSE-MIT",
	"README.md",
	"fgj",
];

/**
 * Selects one supported native build target.
 * @param platform - The operating system reported by the build host.
 * @param arch - The architecture reported by the build host.
 * @returns The archive platform name and Bun compilation target.
 * @example
 * nativeTarget("darwin", "arm64"); // { name: "macos-arm64", target: "bun-darwin-arm64" }
 */
export function nativeTarget(platform: string, arch: string) {
	if (arch === "arm64" && (platform === "darwin" || platform === "linux"))
		return {
			name: `${platform === "darwin" ? "macos" : platform}-arm64`,
			target: `bun-${platform}-arm64`,
		};
	throw new Error(
		"Native packaging supports macOS arm64 and Linux arm64 only.",
	);
}

function run(argv: string[], cwd = ROOT, env = process.env): string {
	const result = Bun.spawnSync(argv, {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(result.stderr.toString().trim() || `${argv[0]} failed.`);
	return result.stdout.toString();
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function cleanSource(): string {
	if (run(["git", "status", "--porcelain", "--untracked-files=all"]).trim())
		throw new Error("Native packaging requires a clean Git checkout.");
	const head = run(["git", "rev-parse", "HEAD"]).trim();
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))
		throw new Error("Native packaging requires a committed source revision.");
	return head;
}

async function pack() {
	if (process.argv.length !== 2)
		throw new Error("Native candidate packaging accepts no arguments.");
	const target = nativeTarget(process.platform, process.arch);
	if (process.platform === "linux") {
		try {
			if (!run(["getconf", "GNU_LIBC_VERSION"]).startsWith("glibc "))
				throw new Error("Unsupported libc.");
		} catch {
			throw new Error("Native Linux packaging requires glibc and getconf.");
		}
	}
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
	if (
		Bun.version !== "1.3.14" ||
		run(["bun", "--version"]).trim() !== Bun.version
	)
		throw new Error(
			"Native packaging requires Bun 1.3.14 for both build steps.",
		);
	const repository = "repository" in pkg ? pkg.repository : undefined;
	if (
		!repository ||
		typeof repository !== "object" ||
		!("type" in repository) ||
		repository.type !== "git" ||
		!("url" in repository) ||
		typeof repository.url !== "string" ||
		Object.keys(repository).length !== 2
	)
		throw new Error("Native packaging requires GitHub repository metadata.");
	const repositoryUrl = repository.url.match(
		/^git\+(https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)\.git$/,
	)?.[1];
	if (!repositoryUrl)
		throw new Error("Native packaging requires GitHub repository metadata.");
	const source = cleanSource();
	const version = `${pkg.version}+${run(["git", "rev-parse", "--short", "HEAD"]).trim()}`;
	const texts = {
		"LICENSE-MIT": readFileSync(join(ROOT, "LICENSE-MIT"), "utf8"),
		"LICENSE-APACHE": readFileSync(join(ROOT, "LICENSE-APACHE"), "utf8"),
		"BUN-LICENSE.md": readFileSync(join(ROOT, "docs/bun-license.md"), "utf8"),
		"README.md": readFileSync(join(ROOT, "docs/native.md"), "utf8")
			.replaceAll("fgj-VERSION", `fgj-${pkg.version}`)
			.replaceAll(
				"](release.md)",
				`](${repositoryUrl}/blob/${source}/docs/release.md)`,
			)
			.replaceAll(
				"](setup.md)",
				`](${repositoryUrl}/blob/${source}/docs/setup.md)`,
			)
			.replaceAll("](bun-license.md)", "](BUN-LICENSE.md)")
			.replaceAll(
				"](../README.md#get-started)",
				`](${repositoryUrl}/blob/${source}/README.md#get-started)`,
			),
	};
	const checks = [
		{
			text: texts["LICENSE-MIT"],
			required: [
				"MIT License",
				"Copyright",
				"Permission is hereby granted, free of charge",
			],
		},
		{
			text: texts["LICENSE-APACHE"],
			required: [
				"Apache License",
				"Version 2.0, January 2004",
				"TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
			],
		},
		{
			text: texts["BUN-LICENSE.md"],
			required: [
				"bun-v1.3.14/LICENSE.md",
				"MIT-licensed",
				"statically links JavaScriptCore",
				"LGPL-2",
			],
		},
		{
			text: texts["README.md"],
			required: [
				"Local native candidate",
				"Auth and network commands require Git on PATH.",
				"Apple notarization",
			],
		},
	];
	if (
		checks.some(({ text, required }) =>
			required.some((part) => !text.includes(part)),
		)
	)
		throw new Error(
			"Native packaging requires both licenses and the candidate guides.",
		);
	const output = join(ROOT, "dist/native");
	const filename = `fgj-${pkg.version}-${target.name}.tar.gz`;
	const tarball = join(output, filename);
	if (existsSync(tarball) || existsSync(`${tarball}.sha256`))
		throw new Error("A native candidate already exists. Use a fresh checkout.");
	mkdirSync(output, { recursive: true });
	const scratch = mkdtempSync(join(output, ".native-"));
	const stagedArchive = join(scratch, filename);
	try {
		const stage = join(scratch, "stage");
		mkdirSync(stage);
		const binary = join(stage, "fgj");
		run([
			process.execPath,
			"--no-env-file",
			"--config=/dev/null",
			join(ROOT, "scripts/build.ts"),
			"--target",
			target.target,
			"--outfile",
			binary,
		]);
		for (const [name, text] of Object.entries(texts))
			await Bun.write(join(stage, name), text);
		for (const name of INVENTORY) {
			chmodSync(join(stage, name), name === "fgj" ? 0o755 : 0o644);
			utimesSync(join(stage, name), 0, 0);
		}
		const owners =
			process.platform === "darwin"
				? ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"]
				: ["--owner=0", "--group=0", "--numeric-owner"];
		run(
			[
				"tar",
				"--format=ustar",
				...owners,
				"-czf",
				stagedArchive,
				"-C",
				stage,
				...INVENTORY,
			],
			ROOT,
			{ ...process.env, COPYFILE_DISABLE: "1" },
		);
		const inventory = run(["tar", "-tzf", stagedArchive])
			.trim()
			.split("\n")
			.sort();
		if (JSON.stringify(inventory) !== JSON.stringify(INVENTORY))
			throw new Error("The native archive has unexpected members.");
		const extracted = join(scratch, "extracted");
		mkdirSync(extracted);
		run(["tar", "-xzf", stagedArchive, "-C", extracted]);
		const installed = join(extracted, "fgj");
		const binaryDigest = sha256(binary);
		if (
			sha256(installed) !== binaryDigest ||
			!(statSync(installed).mode & 0o100)
		)
			throw new Error(
				"The archived executable changed or lost its execute permission.",
			);
		if (process.platform === "darwin")
			run(["/usr/bin/codesign", "--verify", "--strict", installed]);
		const emptyPath = join(scratch, "empty-path");
		mkdirSync(emptyPath);
		const env = { HOME: extracted, TMPDIR: scratch, PATH: emptyPath };
		for (const command of ["version", "help"]) {
			const result = JSON.parse(run([installed, command], extracted, env));
			if (result.version !== version)
				throw new Error(
					"The archived executable does not match its source version.",
				);
		}
		if (cleanSource() !== source)
			throw new Error("Source changed during native packaging.");
		const digest = sha256(stagedArchive);
		const stagedChecksum = `${stagedArchive}.sha256`;
		await Bun.write(stagedChecksum, `${digest}  ${filename}\n`);
		linkSync(stagedArchive, tarball);
		try {
			linkSync(stagedChecksum, `${tarball}.sha256`);
		} catch (error) {
			if (statSync(tarball).ino === statSync(stagedArchive).ino)
				rmSync(tarball);
			throw error;
		}
		return {
			local_only: true,
			tarball,
			sha256: digest,
			binary_sha256: binaryDigest,
			source_sha: source,
			version,
			package_version: pkg.version,
			platform: target.name,
			bun: Bun.version,
			bun_revision: Bun.revision,
			inventory,
			macos_signing: process.platform === "darwin" ? "ad-hoc" : null,
			apple_notarization: false,
			workflow: null,
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main)
	pack()
		.then((result) => console.log(JSON.stringify(result)))
		.catch((error: unknown) => {
			console.error(
				error instanceof Error ? error.message : "Native packaging failed.",
			);
			process.exit(1);
		});

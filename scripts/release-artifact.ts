#!/usr/bin/env bun
/** Binds one release archive to the source, workflow, run and attempt. It never stages or publishes. */
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CANDIDATE = "candidate.tgz";
const EVIDENCE = "evidence.json";

type Evidence = Record<string, string>;

function refuse(message: string): never {
	throw new Error(`Release artifact: ${message}`);
}

function object(path: string): Record<string, unknown> {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value))
		refuse("Invalid artifact metadata.");
	return value as Record<string, unknown>;
}

function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		refuse("Use the expected archive SHA-256 from the build job.");
	return value;
}

function bindings(): void {
	for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
		if (!/^[1-9][0-9]*$/.test(process.env[key] ?? ""))
			refuse("Use a GitHub run ID and attempt.");
	}
	for (const key of ["GITHUB_ENV", "GITHUB_OUTPUT"]) {
		const path = process.env[key];
		if (!path || !isAbsolute(path) || /[\r\n]/.test(path))
			refuse("Use GitHub environment and output files.");
	}
}

function inspect(path: string, sha256: string): Evidence {
	const result = Bun.spawnSync(
		[
			process.execPath,
			join(ROOT, "scripts/release-check.ts"),
			"--archive",
			path,
			"--sha256",
			sha256,
		],
		{ cwd: ROOT, env: process.env, stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) {
		const message = result.stderr.toString().trim();
		throw new Error(
			/^Release check: [^\r\n]+$/.test(message)
				? message
				: "Release artifact: Source or archive check failed.",
		);
	}
	const checked = JSON.parse(result.stdout.toString()) as Record<
		string,
		unknown
	>;
	const evidence: Evidence = { sha256 };
	for (const key of ["version", "commit", "repository", "tag", "distTag"]) {
		const value = checked[key];
		if (typeof value !== "string") refuse("Invalid release check result.");
		evidence[key] = value;
	}
	evidence.runId = process.env.GITHUB_RUN_ID as string;
	evidence.runAttempt = process.env.GITHUB_RUN_ATTEMPT as string;
	evidence.workflowRef = process.env.GITHUB_WORKFLOW_REF as string;
	evidence.workflowSha = process.env.GITHUB_WORKFLOW_SHA as string;
	return evidence;
}

function expose(directory: string, evidence: Evidence): void {
	appendFileSync(
		process.env.GITHUB_ENV as string,
		`FGJ_PACKAGE_TARBALL=${join(directory, CANDIDATE)}\nFGJ_RELEASE_SHA256=${evidence.sha256}\n`,
	);
	appendFileSync(
		process.env.GITHUB_OUTPUT as string,
		`sha256=${evidence.sha256}\n`,
	);
	console.log(JSON.stringify(evidence));
}

function prepare(metadataPath: string, directory: string): void {
	if (existsSync(directory)) refuse("Do not overwrite a retained candidate.");
	const metadata = object(metadataPath);
	if (typeof metadata.tarball !== "string" || !isAbsolute(metadata.tarball))
		refuse("Use the absolute archive path from packaging.");
	const sha256 = digest(metadata.sha256);
	inspect(metadata.tarball, sha256);
	mkdirSync(directory);
	let retained = false;
	try {
		const path = join(directory, CANDIDATE);
		copyFileSync(metadata.tarball, path);
		const evidence = inspect(path, sha256);
		writeFileSync(
			join(directory, EVIDENCE),
			`${JSON.stringify(evidence, null, 2)}\n`,
		);
		expose(directory, evidence);
		retained = true;
	} finally {
		if (!retained) rmSync(directory, { recursive: true, force: true });
	}
}

function verify(directory: string, expected: string): void {
	if (
		!lstatSync(directory).isDirectory() ||
		JSON.stringify(readdirSync(directory).sort()) !==
			JSON.stringify([CANDIDATE, EVIDENCE])
	)
		refuse("Artifact must contain only the candidate and evidence.");
	for (const file of [CANDIDATE, EVIDENCE]) {
		if (!lstatSync(join(directory, file)).isFile())
			refuse("Candidate and evidence must be regular files.");
	}
	const evidence = inspect(join(directory, CANDIDATE), digest(expected));
	const retained = object(join(directory, EVIDENCE));
	if (
		Object.keys(retained).length !== Object.keys(evidence).length ||
		!Object.entries(evidence).every(([key, value]) => retained[key] === value)
	)
		refuse("Evidence must match this source, workflow, run and attempt.");
	expose(directory, evidence);
}

try {
	const args = process.argv.slice(2);
	if (
		args.length !== 3 ||
		(args[0] !== "prepare" && args[0] !== "verify") ||
		!args[1] ||
		!args[2]
	)
		refuse(
			"Use prepare with metadata and a directory, or verify with a directory and expected digest.",
		);
	bindings();
	const directory = resolve(args[0] === "prepare" ? args[2] : args[1]);
	if (/[\r\n]/.test(directory)) refuse("Invalid artifact path.");
	if (args[0] === "prepare") prepare(resolve(args[1]), directory);
	else verify(directory, args[2]);
} catch (error) {
	const message =
		error instanceof Error &&
		/^(?:Release artifact|Release check):/.test(error.message)
			? error.message
			: "Release artifact: Cannot read artifact inputs.";
	console.error(message);
	process.exit(1);
}

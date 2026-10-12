#!/usr/bin/env bun
/** Checks release source and optional archive inputs. It never stages or publishes. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

function refuse(message: string): never {
	throw new Error(`Release check: ${message}`);
}

function command(argv: string[], message: string): string {
	const result = Bun.spawnSync(argv, {
		cwd: ROOT,
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) refuse(message);
	return result.stdout.toString();
}

function object(text: string, message: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		refuse(message);
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		refuse(message);
	return value as Record<string, unknown>;
}

function repositoryMatches(value: unknown, expectedUrl?: string): boolean {
	if (
		!value ||
		typeof value !== "object" ||
		Object.keys(value).length !== 2 ||
		!("type" in value) ||
		value.type !== "git" ||
		!("url" in value) ||
		typeof value.url !== "string"
	)
		return false;
	const match =
		/^git\+https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\.git$/.exec(
			value.url,
		);
	return (
		match?.[0] === value.url &&
		(expectedUrl === undefined || value.url === expectedUrl)
	);
}

function argumentsForArchive() {
	const args = process.argv.slice(2);
	const values: Record<string, string> = {};
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (
			(key !== "--archive" && key !== "--sha256") ||
			!value ||
			value.startsWith("--") ||
			key in values
		)
			refuse("Invalid arguments.");
		values[key] = value;
	}
	const path = values["--archive"];
	const sha256 = values["--sha256"];
	if (
		Boolean(path) !== Boolean(sha256) ||
		(sha256 !== undefined &&
			(sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(sha256)))
	)
		refuse("Invalid arguments.");
	return path && sha256 ? { path: resolve(path), sha256 } : undefined;
}

function checkCredentials(mode: string): void {
	const names = Object.entries(process.env)
		.filter(([, value]) => Boolean(value))
		.map(([name]) => name);
	const publishingToken = names.some((name) =>
		/^(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_ID_TOKEN|SIGSTORE_ID_TOKEN|npm_config_.*(?:auth|token|password).*)$/i.test(
			name,
		),
	);
	const oidc = names.some((name) =>
		/^ACTIONS_ID_TOKEN_REQUEST_(TOKEN|URL)$/.test(name),
	);
	if (mode === "dry-run" && (publishingToken || oidc))
		refuse("Dry-run must have no publishing credentials or OIDC.");
	if (mode === "stage" && publishingToken)
		refuse("Stage must have no npm publishing token.");
	if (
		mode === "stage" &&
		(!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
			!process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
	)
		refuse("Stage requires OIDC.");
}

function inspectArchive(
	archive: { path: string; sha256: string },
	version: string,
	commit: string,
	repositoryUrl: string,
) {
	if (!lstatSync(archive.path).isFile())
		refuse("The archive must be a regular file.");
	const bytes = readFileSync(archive.path);
	const digest = (value: Buffer) =>
		createHash("sha256").update(value).digest("hex");
	if (digest(bytes) !== archive.sha256) refuse("Archive digest must match.");
	const inventory = command(
		["tar", "-tzf", archive.path],
		"Cannot read archive inventory.",
	)
		.trim()
		.split("\n")
		.filter((path) => path !== "package/")
		.sort();
	const expected = [
		"LICENSE-APACHE",
		"LICENSE-MIT",
		"README.md",
		"cli.js",
		"package.json",
	].map((path) => `package/${path}`);
	if (JSON.stringify(inventory) !== JSON.stringify(expected))
		refuse("Invalid archive inventory.");
	const metadata = object(
		command(
			["tar", "-xOf", archive.path, "package/package.json"],
			"Cannot read packed metadata.",
		),
		"Invalid packed metadata.",
	);
	const fields = [
		"bin",
		"cpu",
		"description",
		"engines",
		"license",
		"name",
		"os",
		"repository",
		"type",
		"version",
	];
	if (
		JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(fields) ||
		metadata.name !== "fgj" ||
		metadata.version !== version ||
		metadata.license !== "MIT OR Apache-2.0" ||
		metadata.type !== "module" ||
		metadata.description !== "Forgejo command-line interface for LLM agents" ||
		!repositoryMatches(metadata.repository, repositoryUrl) ||
		JSON.stringify(metadata.bin) !== JSON.stringify({ fgj: "cli.js" }) ||
		JSON.stringify(metadata.engines) !== JSON.stringify({ bun: "1.3.14" }) ||
		JSON.stringify(metadata.os) !== JSON.stringify(["darwin", "linux"]) ||
		JSON.stringify(metadata.cpu) !== JSON.stringify(["arm64"])
	)
		refuse("Invalid packed metadata.");
	const bundle = command(
		["tar", "-xOf", archive.path, "package/cli.js"],
		"Cannot read packed bundle.",
	);
	const shortCommit = command(
		["git", "rev-parse", "--short", commit],
		"Cannot resolve the build commit.",
	).trim();
	if (
		!bundle.startsWith(
			"#!/usr/bin/env -S bun --no-env-file --config=/dev/null\n",
		) ||
		!bundle.includes(`${version}+${shortCommit}`) ||
		bundle.includes(`${version}+${shortCommit}-dirty`)
	)
		refuse("Invalid packed build identity.");
	for (const file of ["LICENSE-MIT", "LICENSE-APACHE"]) {
		const packed = command(
			["tar", "-xOf", archive.path, `package/${file}`],
			"Cannot read packed license.",
		);
		if (packed !== readFileSync(join(ROOT, file), "utf8"))
			refuse("Packed licenses must match source.");
	}
	if (digest(readFileSync(archive.path)) !== archive.sha256)
		refuse("Archive digest must match.");
	return { sha256: archive.sha256, bytes: bytes.length };
}

function check(): void {
	const archive = argumentsForArchive();
	const mode = process.env.FGJ_RELEASE_MODE ?? "dry-run";
	const requested = process.env.FGJ_RELEASE_REQUESTED_MODE ?? mode;
	if (
		(mode !== "dry-run" && mode !== "stage") ||
		(requested !== "dry-run" && requested !== "stage")
	)
		refuse("Use dry-run or stage.");
	checkCredentials(mode);
	const pkg = object(
		readFileSync(join(ROOT, "package.json"), "utf8"),
		"Invalid source metadata.",
	);
	const version = pkg.version;
	if (
		typeof version !== "string" ||
		!/^[0-9][0-9A-Za-z.+-]*$/.test(version) ||
		!Bun.semver.satisfies(version, version)
	)
		refuse("Invalid package version.");
	if (pkg.name !== "fgj" || pkg.license !== "MIT OR Apache-2.0")
		refuse("Invalid source metadata.");
	if (!repositoryMatches(pkg.repository))
		refuse("Invalid source repository metadata.");
	const repositoryUrl = (pkg.repository as { url: string }).url;
	const repository = repositoryUrl.slice(
		"git+https://github.com/".length,
		-".git".length,
	);
	const owner = repository.split("/")[0];
	const tag = `v${version}`;
	const ref = `refs/tags/${tag}`;
	const env = process.env;
	if (env.GITHUB_ACTIONS !== "true") refuse("Use GitHub Actions.");
	if (env.GITHUB_EVENT_NAME !== "workflow_dispatch")
		refuse("Use workflow_dispatch.");
	if (
		env.GITHUB_REPOSITORY !== repository ||
		env.GITHUB_SERVER_URL !== "https://github.com"
	)
		refuse("Use the approved repository.");
	if (env.GITHUB_ACTOR !== owner || env.GITHUB_TRIGGERING_ACTOR !== owner)
		refuse("The owner must start or retry the run.");
	if (mode === "stage" || requested === "stage") {
		const reason = "Staging requires the public GitHub repository.";
		let event: Record<string, unknown>;
		try {
			event = object(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8"), reason);
		} catch {
			refuse(reason);
		}
		const eventRepository = event.repository;
		if (
			!eventRepository ||
			typeof eventRepository !== "object" ||
			!("full_name" in eventRepository) ||
			eventRepository.full_name !== repository ||
			!("private" in eventRepository) ||
			eventRepository.private !== false
		)
			refuse(reason);
	}
	if (env.RUNNER_ENVIRONMENT !== "github-hosted")
		refuse("Use a GitHub-hosted runner.");
	if (env.GITHUB_REF !== ref)
		refuse("The ref must match the package version tag.");
	if (
		env.GITHUB_WORKFLOW_REF !==
		`${repository}/.github/workflows/release.yml@${ref}`
	)
		refuse("Use the release workflow at the version tag.");
	const distTag = env.FGJ_RELEASE_DIST_TAG;
	const prerelease = version.split("+")[0]?.includes("-");
	if (prerelease && distTag !== "rc") refuse("Use rc for a prerelease.");
	if (!prerelease && distTag !== "latest")
		refuse("Use latest for a stable release.");
	if (
		command(
			["git", "status", "--porcelain", "--untracked-files=all"],
			"Cannot inspect the release tree.",
		)
	)
		refuse("The release tree must be clean.");
	const commit = command(
		["git", "rev-parse", "--verify", "HEAD^{commit}"],
		"Cannot resolve checkout HEAD.",
	).trim();
	if (env.GITHUB_SHA !== commit) refuse("Event SHA must match checkout HEAD.");
	if (env.GITHUB_WORKFLOW_SHA !== commit)
		refuse("Workflow SHA must match checkout HEAD.");
	const tagged = command(
		["git", "rev-parse", "--verify", `${ref}^{commit}`],
		"Cannot resolve the release tag.",
	).trim();
	if (tagged !== commit) refuse("Tag commit must match checkout HEAD.");
	command(
		["git", "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"],
		"The commit must belong to origin/main.",
	);
	console.log(
		JSON.stringify({
			mode,
			version,
			commit,
			tag,
			distTag,
			repository,
			...(archive
				? { archive: inspectArchive(archive, version, commit, repositoryUrl) }
				: {}),
		}),
	);
}

try {
	check();
} catch (error) {
	const message =
		error instanceof Error && error.message.startsWith("Release check:")
			? error.message
			: "Release check: Cannot read candidate inputs.";
	console.error(message);
	process.exit(1);
}

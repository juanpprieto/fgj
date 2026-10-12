import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanEnv, tempDir } from "../support/tmp.ts";

const ROOT = join(import.meta.dir, "../..");
const REPOSITORY = {
	type: "git",
	url: "git+https://github.com/example-owner/fgj.git",
};

function run(cwd: string, argv: string[], env = cleanEnv(cwd)) {
	const result = Bun.spawnSync(argv, {
		cwd,
		env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function git(home: string, ...argv: string[]): string {
	const result = run(home, ["git", ...argv]);
	expect(result.code, result.stderr).toBe(0);
	return result.stdout.trim();
}

function fixture(version = "0.1.0-rc.1") {
	const home = realpathSync(tempDir("fgj-release-source-"));
	mkdirSync(join(home, "scripts"));
	mkdirSync(join(home, "src"));
	for (const file of [
		"README.md",
		"scripts/build.ts",
		"scripts/package.ts",
		"scripts/release-check.ts",
		"scripts/release-artifact.ts",
		"LICENSE-MIT",
		"LICENSE-APACHE",
	])
		if (existsSync(join(ROOT, file)))
			copyFileSync(join(ROOT, file), join(home, file));
	writeFileSync(join(home, ".gitignore"), "dist/\n");
	const metadata = {
		name: "fgj",
		version,
		license: "MIT OR Apache-2.0",
		repository: REPOSITORY,
	};
	writeFileSync(join(home, "package.json"), JSON.stringify(metadata));
	writeFileSync(
		join(home, "src/cli.ts"),
		"#!/usr/bin/env -S bun --no-env-file --config=/dev/null\nconsole.log(JSON.stringify({version: FGJ_VERSION}));\n",
	);
	git(home, "init", "-q", "-b", "main");
	git(home, "add", ".");
	git(
		home,
		"-c",
		"user.name=Example",
		"-c",
		"user.email=example@example.invalid",
		"commit",
		"-qm",
		"Reviewed source",
	);
	const commit = git(home, "rev-parse", "HEAD");
	git(home, "update-ref", "refs/remotes/origin/main", commit);
	git(home, "tag", `v${version}`);
	const eventPath = join(home, ".git/event.json");
	writeFileSync(
		eventPath,
		JSON.stringify({
			repository: { full_name: "example-owner/fgj", private: false },
		}),
	);
	const env: Record<string, string> = {
		...cleanEnv(home),
		GITHUB_ACTIONS: "true",
		GITHUB_SERVER_URL: "https://github.com",
		GITHUB_REPOSITORY: "example-owner/fgj",
		GITHUB_REPOSITORY_ID: "202",
		GITHUB_REPOSITORY_OWNER_ID: "303",
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_EVENT_PATH: eventPath,
		GITHUB_RUN_ID: "101",
		GITHUB_RUN_ATTEMPT: "1",
		GITHUB_ENV: join(home, ".git/github-env"),
		GITHUB_OUTPUT: join(home, ".git/github-output"),
		GITHUB_REF: `refs/tags/v${version}`,
		GITHUB_SHA: commit,
		GITHUB_ACTOR: "example-owner",
		GITHUB_TRIGGERING_ACTOR: "example-owner",
		GITHUB_WORKFLOW_REF: `example-owner/fgj/.github/workflows/release.yml@refs/tags/v${version}`,
		GITHUB_WORKFLOW_SHA: commit,
		RUNNER_ENVIRONMENT: "github-hosted",
		FGJ_RELEASE_DIST_TAG: version.includes("-") ? "rc" : "latest",
	};
	return { home, metadata, commit, env };
}

function check(
	input: ReturnType<typeof fixture>,
	args: string[] = [],
	env: Record<string, string> = input.env,
) {
	return run(
		input.home,
		[process.execPath, "scripts/release-check.ts", ...args],
		env,
	);
}

function refused(result: ReturnType<typeof run>, reason: string) {
	expect(result.code).not.toBe(0);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain(`Release check: ${reason}`);
}

function changeMetadata(
	input: ReturnType<typeof fixture>,
	values: Record<string, unknown>,
) {
	writeFileSync(
		join(input.home, "package.json"),
		JSON.stringify({ ...input.metadata, ...values }),
	);
}

function archive(
	input: ReturnType<typeof fixture>,
	values: Record<string, unknown> = {},
	files: Record<string, string> = {},
) {
	const stage = realpathSync(tempDir("fgj-release-archive-"));
	mkdirSync(join(stage, "package"));
	const manifest = {
		name: "fgj",
		version: input.metadata.version,
		license: input.metadata.license,
		description: "Forgejo command-line interface for LLM agents",
		type: "module",
		bin: { fgj: "cli.js" },
		engines: { bun: "1.3.14" },
		os: ["darwin", "linux"],
		cpu: ["arm64"],
		repository: REPOSITORY,
		...values,
	};
	writeFileSync(join(stage, "package/package.json"), JSON.stringify(manifest));
	writeFileSync(
		join(stage, "package/cli.js"),
		`#!/usr/bin/env -S bun --no-env-file --config=/dev/null\nconsole.log("${input.metadata.version}+${git(input.home, "rev-parse", "--short", "HEAD")}");\n`,
	);
	writeFileSync(join(stage, "package/README.md"), "Synthetic archive\n");
	for (const file of ["LICENSE-MIT", "LICENSE-APACHE"])
		copyFileSync(join(ROOT, file), join(stage, "package", file));
	for (const [file, content] of Object.entries(files))
		writeFileSync(join(stage, "package", file), content);
	const path = join(stage, `fgj-${input.metadata.version}.tgz`);
	const packed = run(stage, ["tar", "-czf", path, "package"]);
	expect(packed.code, packed.stderr).toBe(0);
	const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
	return { path, sha256, args: ["--archive", path, "--sha256", sha256] };
}

describe("release source refusal", () => {
	test("source metadata names the approved GitHub repository", () => {
		const metadata = JSON.parse(
			readFileSync(join(ROOT, "package.json"), "utf8"),
		);
		expect(metadata.repository.type).toBe("git");
		expect(metadata.repository.url).toMatch(
			/^git\+https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/,
		);
	});

	test.each(["0.1.0", "0.1.0-rc.1"])(
		"accepts owner-dispatched %s with matching source and tag",
		(version) => {
			const input = fixture(version);
			const result = check(input);
			expect(result.code, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				mode: "dry-run",
				version,
				commit: input.commit,
				tag: `v${version}`,
				distTag: input.env.FGJ_RELEASE_DIST_TAG,
			});
		},
	);

	test.each([
		["GITHUB_ACTIONS", "false", "Use GitHub Actions"],
		["GITHUB_EVENT_NAME", "push", "Use workflow_dispatch"],
		["GITHUB_EVENT_NAME", "pull_request", "Use workflow_dispatch"],
		["GITHUB_EVENT_NAME", "pull_request_target", "Use workflow_dispatch"],
		["GITHUB_EVENT_NAME", "workflow_run", "Use workflow_dispatch"],
		["GITHUB_EVENT_NAME", "issue_comment", "Use workflow_dispatch"],
		["GITHUB_ACTOR", "example", "The owner must start"],
		["GITHUB_TRIGGERING_ACTOR", "example", "The owner must start"],
		["GITHUB_ACTOR", "other-owner", "The owner must start"],
		["GITHUB_TRIGGERING_ACTOR", "other-owner", "The owner must start"],
		["GITHUB_REPOSITORY", "example/fgj", "Use the approved repository"],
		["GITHUB_REPOSITORY", "other-owner/fgj", "Use the approved repository"],
		[
			"GITHUB_SERVER_URL",
			"https://example.invalid",
			"Use the approved repository",
		],
		["RUNNER_ENVIRONMENT", "self-hosted", "Use a GitHub-hosted runner"],
		["GITHUB_REF", "refs/heads/main", "The ref must match"],
		["GITHUB_REF", "refs/tags/v0.1.0", "The ref must match"],
		["GITHUB_SHA", "0".repeat(40), "Event SHA must match"],
		["GITHUB_WORKFLOW_SHA", "0".repeat(40), "Workflow SHA must match"],
		[
			"GITHUB_WORKFLOW_REF",
			"example-owner/fgj/.github/workflows/contributor.yml@refs/heads/main",
			"Use the release workflow",
		],
		[
			"GITHUB_WORKFLOW_REF",
			"other-owner/fgj/.github/workflows/release.yml@refs/tags/v0.1.0-rc.1",
			"Use the release workflow",
		],
		["FGJ_RELEASE_DIST_TAG", "latest", "Use rc for a prerelease"],
		["FGJ_RELEASE_DIST_TAG", "rc\n", "Use rc for a prerelease"],
		["FGJ_RELEASE_MODE", "publish", "Use dry-run or stage"],
		["FGJ_RELEASE_REQUESTED_MODE", "publish", "Use dry-run or stage"],
	])("refuses %s=%s", (key, value, reason) => {
		const input = fixture();
		refused(check(input, [], { ...input.env, [key]: value }), reason);
	});

	test.each(["tracked", "staged", "untracked"])(
		"refuses a %s dirty release tree",
		(kind) => {
			const input = fixture();
			writeFileSync(
				join(
					input.home,
					kind === "untracked" ? "unexpected.txt" : "src/cli.ts",
				),
				"changed\n",
			);
			if (kind === "staged") git(input.home, "add", "src/cli.ts");
			refused(check(input), "The release tree must be clean");
		},
	);

	test("refuses a tag that resolves to another commit", () => {
		const input = fixture();
		const other = git(
			input.home,
			"-c",
			"user.name=Example",
			"-c",
			"user.email=example@example.invalid",
			"commit-tree",
			"HEAD^{tree}",
			"-m",
			"Other commit",
		);
		git(
			input.home,
			"update-ref",
			`refs/tags/v${input.metadata.version}`,
			other,
		);
		refused(check(input), "Tag commit must match");
	});

	test("refuses a missing tag", () => {
		const input = fixture();
		git(input.home, "tag", "-d", `v${input.metadata.version}`);
		refused(check(input), "Cannot resolve the release tag");
	});

	test("refuses a commit outside main", () => {
		const input = fixture();
		const other = git(
			input.home,
			"-c",
			"user.name=Example",
			"-c",
			"user.email=example@example.invalid",
			"commit-tree",
			"HEAD^{tree}",
			"-m",
			"Other root",
		);
		git(input.home, "update-ref", "refs/remotes/origin/main", other);
		refused(check(input), "The commit must belong to origin/main");
	});

	test.each(["0.1.0\n", "v0.1.0", "0.1.0;fixture", "../candidate"])(
		"refuses injected version %j",
		(version) => {
			const input = fixture();
			changeMetadata(input, { version });
			refused(check(input), "Invalid package version");
		},
	);

	test("event context cannot replace the repository bound by source metadata", () => {
		const input = fixture();
		changeMetadata(input, {
			repository: {
				type: "git",
				url: "git+https://github.com/other-owner/fgj.git",
			},
		});
		refused(check(input), "Use the approved repository");
	});

	test.each([
		undefined,
		null,
		{ type: "git", url: "https://github.com/example/fgj.git" },
		{
			type: "git",
			url: "git+https://github.com/example/fgj.git?token=synthetic",
		},
		{ type: "git", url: "git+https://github.com/example/fgj.git\n" },
		{ type: "git", url: "git+https://github.com/../fgj.git" },
		{ ...REPOSITORY, extra: "fixture" },
	])("refuses absent or incorrect source repository %j", (repository) => {
		const input = fixture();
		changeMetadata(input, { repository });
		refused(check(input), "Invalid source repository metadata");
	});
});

describe("release public source requirement", () => {
	test("private dry-run needs no public source or provenance request", () => {
		const input = fixture();
		writeFileSync(
			input.env.GITHUB_EVENT_PATH as string,
			JSON.stringify({
				repository: { full_name: "example-owner/fgj", private: true },
			}),
		);
		expect(check(input).code).toBe(0);
	});

	test.each([
		undefined,
		{},
		{ repository: { full_name: "example-owner/fgj", private: true } },
		{ repository: { full_name: "example/fgj", private: false } },
		{ repository: { full_name: "example-owner/fgj" } },
	])(
		"stage request refuses absent, private or mismatched public source %j",
		(event) => {
			const input = fixture();
			writeFileSync(
				input.env.GITHUB_EVENT_PATH as string,
				event === undefined ? "invalid JSON" : JSON.stringify(event),
			);
			refused(
				check(input, [], { ...input.env, FGJ_RELEASE_REQUESTED_MODE: "stage" }),
				"Staging requires the public GitHub repository",
			);
		},
	);

	test("stage mode cannot bypass the public source requirement", () => {
		const input = fixture();
		writeFileSync(
			input.env.GITHUB_EVENT_PATH as string,
			JSON.stringify({
				repository: { full_name: "example-owner/fgj", private: true },
			}),
		);
		refused(
			check(input, [], {
				...input.env,
				FGJ_RELEASE_MODE: "stage",
				ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic",
			}),
			"Staging requires the public GitHub repository",
		);
	});
});

describe("release credentials and archive refusal", () => {
	test.each([
		"NPM_TOKEN",
		"NODE_AUTH_TOKEN",
		"NPM_CONFIG__AUTHTOKEN",
		"npm_config__auth",
		"ACTIONS_ID_TOKEN_REQUEST_TOKEN",
		"ACTIONS_ID_TOKEN_REQUEST_URL",
		"NPM_ID_TOKEN",
		"SIGSTORE_ID_TOKEN",
	])("dry-run refuses %s without printing its value", (key) => {
		const input = fixture();
		const value = "synthetic-secret-do-not-print";
		const result = check(input, [], { ...input.env, [key]: value });
		refused(result, "Dry-run must have no publishing credentials or OIDC");
		expect(result.stdout + result.stderr).not.toContain(value);
	});

	test("stage refuses ambient npm tokens even with OIDC", () => {
		const input = fixture();
		refused(
			check(input, [], {
				...input.env,
				FGJ_RELEASE_MODE: "stage",
				ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic",
				NPM_TOKEN: "synthetic",
			}),
			"Stage must have no npm publishing token",
		);
	});

	test("stage requires OIDC", () => {
		const input = fixture();
		refused(
			check(input, [], { ...input.env, FGJ_RELEASE_MODE: "stage" }),
			"Stage requires OIDC",
		);
	});

	test("stage context checks accept synthetic OIDC without publishing or printing it", () => {
		const input = fixture();
		const token = "synthetic-oidc-do-not-print";
		const result = check(input, [], {
			...input.env,
			FGJ_RELEASE_MODE: "stage",
			ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid",
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: token,
		});
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).mode).toBe("stage");
		expect(result.stdout + result.stderr).not.toContain(token);
		expect(git(input.home, "status", "--porcelain")).toBe("");
	});

	test("inspects an archive without changing its bytes", () => {
		const input = fixture();
		const packed = archive(input);
		const result = check(input, packed.args);
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).archive).toMatchObject({
			sha256: packed.sha256,
		});
		expect(
			createHash("sha256").update(readFileSync(packed.path)).digest("hex"),
		).toBe(packed.sha256);
	});

	test("refuses changed license bytes even when only whitespace differs", () => {
		const input = fixture();
		const license = readFileSync(join(ROOT, "LICENSE-MIT"), "utf8");
		const packed = archive(input, {}, { "LICENSE-MIT": `${license}\n` });
		refused(check(input, packed.args), "Packed licenses must match source");
	});

	test("refuses an archive built from another commit", () => {
		const input = fixture();
		const packed = archive(
			input,
			{},
			{
				"cli.js": `#!/usr/bin/env -S bun --no-env-file --config=/dev/null\nconsole.log("${input.metadata.version}+${"0".repeat(7)}");\n`,
			},
		);
		refused(check(input, packed.args), "Invalid packed build identity");
	});

	test("refuses an extra archived file", () => {
		const input = fixture();
		const packed = archive(input, {}, { "extra.txt": "synthetic\n" });
		refused(check(input, packed.args), "Invalid archive inventory");
	});

	test.each(["0.1.0", "0.1.0-rc.1"])(
		"release packaging builds and checks %s without dirtying source",
		(version) => {
			const input = fixture(version);
			const result = run(
				input.home,
				[process.execPath, "scripts/package.ts", "--release"],
				input.env,
			);
			expect(result.code, result.stderr).toBe(0);
			const packed = JSON.parse(result.stdout);
			const verified = check(input, [
				"--archive",
				packed.tarball,
				"--sha256",
				packed.sha256,
			]);
			expect(verified.code, verified.stderr).toBe(0);
			expect(JSON.parse(verified.stdout).archive.sha256).toBe(packed.sha256);
			const home = realpathSync(tempDir("fgj-release-smoke-"));
			const extracted = run(home, ["tar", "-xzf", packed.tarball, "-C", home]);
			expect(extracted.code, extracted.stderr).toBe(0);
			const smoke = run(home, [
				process.execPath,
				"--no-env-file",
				"--config=/dev/null",
				"package/cli.js",
				"version",
			]);
			expect(smoke.code, smoke.stderr).toBe(0);
			expect(JSON.parse(smoke.stdout)).toEqual({
				version: `${version}+${git(input.home, "rev-parse", "--short", "HEAD")}`,
			});
			expect(git(input.home, "status", "--porcelain")).toBe("");
		},
		30_000,
	);

	test.each([
		{ repository: undefined },
		{
			repository: {
				type: "git",
				url: "git+https://github.com/example/fgj.git",
			},
		},
		{
			repository: {
				type: "git",
				url: "git+https://github.com/other-owner/fgj.git",
			},
		},
		{ version: "0.1.0" },
		{ name: "other" },
		{ scripts: { preinstall: "synthetic" } },
		{ dependencies: { synthetic: "1.0.0" } },
	])("refuses incorrect packed metadata %j", (values) => {
		const input = fixture();
		const packed = archive(input, values);
		refused(check(input, packed.args), "Invalid packed metadata");
	});

	test("refuses an archive digest mismatch", () => {
		const input = fixture();
		const packed = archive(input);
		refused(
			check(input, ["--archive", packed.path, "--sha256", "0".repeat(64)]),
			"Archive digest must match",
		);
	});

	test.each(
		[
			["--archive"],
			["--archive", "/missing"],
			["--sha256", "0".repeat(64)],
			["--publish"],
			["--archive", "/missing", "--sha256", "not-a-digest"],
		].map((args) => ({ args })),
	)("refuses malformed arguments %j", ({ args }) => {
		refused(check(fixture(), args), "Invalid arguments");
	});

	test("release packaging refuses a dirty tree before building or writing an archive", () => {
		const input = fixture();
		writeFileSync(join(input.home, "src/cli.ts"), "changed\n");
		const result = run(
			input.home,
			[process.execPath, "scripts/package.ts", "--release"],
			input.env,
		);
		refused(result, "The release tree must be clean");
		expect(existsSync(join(input.home, "dist"))).toBe(false);
	});

	test("release build refuses a dirty tree before invoking Bun build", () => {
		const input = fixture();
		writeFileSync(join(input.home, "src/cli.ts"), "changed\n");
		const result = run(
			input.home,
			[process.execPath, "scripts/build.ts", "--bundle", "--release"],
			input.env,
		);
		refused(result, "The release tree must be clean");
		expect(existsSync(join(input.home, "dist"))).toBe(false);
	});
});

function artifactCommand(
	input: ReturnType<typeof fixture>,
	args: string[],
	env = input.env,
) {
	return run(
		input.home,
		[process.execPath, "scripts/release-artifact.ts", ...args],
		env,
	);
}

function preparedArtifact(input: ReturnType<typeof fixture>) {
	const packed = archive(input);
	const metadata = join(input.home, ".git/candidate.json");
	const directory = join(input.home, ".git/fgj-release");
	writeFileSync(
		metadata,
		JSON.stringify({
			tarball: packed.path,
			sha256: packed.sha256,
			inventory: [],
		}),
	);
	const result = artifactCommand(input, ["prepare", metadata, directory]);
	expect(result.code, result.stderr).toBe(0);
	return {
		...packed,
		directory,
		metadata,
		candidate: join(directory, "candidate.tgz"),
		evidence: join(directory, "evidence.json"),
	};
}

describe("same-run release artifact", () => {
	test("retains exact bytes and exports the candidate path and digest", () => {
		const input = fixture();
		const packed = preparedArtifact(input);
		expect(readFileSync(packed.candidate)).toEqual(readFileSync(packed.path));
		expect(readFileSync(input.env.GITHUB_ENV as string, "utf8")).toContain(
			`FGJ_PACKAGE_TARBALL=${packed.candidate}\n`,
		);
		expect(readFileSync(input.env.GITHUB_OUTPUT as string, "utf8")).toContain(
			`sha256=${packed.sha256}\n`,
		);
		const evidence = JSON.parse(readFileSync(packed.evidence, "utf8"));
		expect(evidence).toMatchObject({
			commit: input.commit,
			sha256: packed.sha256,
			runId: "101",
			runAttempt: "1",
			workflowRef: input.env.GITHUB_WORKFLOW_REF,
		});
		const result = artifactCommand(input, [
			"verify",
			packed.directory,
			packed.sha256,
		]);
		expect(result.code, result.stderr).toBe(0);
		expect(git(input.home, "status", "--porcelain")).toBe("");
	});

	test.each([
		"commit",
		"repository",
		"tag",
		"version",
		"distTag",
		"sha256",
		"runId",
		"runAttempt",
		"workflowRef",
		"workflowSha",
	])("refuses changed evidence field %s", (key) => {
		const input = fixture();
		const packed = preparedArtifact(input);
		const evidence = JSON.parse(readFileSync(packed.evidence, "utf8"));
		evidence[key] = "wrong";
		writeFileSync(packed.evidence, JSON.stringify(evidence));
		const result = artifactCommand(input, [
			"verify",
			packed.directory,
			packed.sha256,
		]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain(
			"Release artifact: Evidence must match this source, workflow, run and attempt.",
		);
	});

	test("refuses an archive from an earlier attempt", () => {
		const input = fixture();
		const packed = preparedArtifact(input);
		const result = artifactCommand(
			input,
			["verify", packed.directory, packed.sha256],
			{ ...input.env, GITHUB_RUN_ATTEMPT: "2" },
		);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Evidence must match");
	});

	test("refuses changed archive bytes and a digest supplied only by the artifact", () => {
		const input = fixture();
		const packed = preparedArtifact(input);
		writeFileSync(
			packed.candidate,
			Buffer.concat([readFileSync(packed.candidate), Buffer.from("changed")]),
		);
		const evidence = JSON.parse(readFileSync(packed.evidence, "utf8"));
		evidence.sha256 = createHash("sha256")
			.update(readFileSync(packed.candidate))
			.digest("hex");
		writeFileSync(packed.evidence, JSON.stringify(evidence));
		const result = artifactCommand(input, [
			"verify",
			packed.directory,
			packed.sha256,
		]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("Archive digest must match");
	});

	test("refuses extra artifact files", () => {
		const input = fixture();
		const packed = preparedArtifact(input);
		writeFileSync(join(packed.directory, "unexpected.txt"), "synthetic\n");
		const result = artifactCommand(input, [
			"verify",
			packed.directory,
			packed.sha256,
		]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain(
			"Artifact must contain only the candidate and evidence",
		);
	});

	test("refuses overwriting an existing prepared artifact", () => {
		const input = fixture();
		const packed = preparedArtifact(input);
		const result = artifactCommand(input, [
			"prepare",
			packed.metadata,
			packed.directory,
		]);
		expect(result.code).not.toBe(0);
		expect(readFileSync(packed.candidate)).toEqual(readFileSync(packed.path));
	});

	test.each([
		"GITHUB_RUN_ID",
		"GITHUB_RUN_ATTEMPT",
		"GITHUB_ENV",
		"GITHUB_OUTPUT",
	])("refuses missing GitHub binding %s before retaining bytes", (key) => {
		const input = fixture();
		const packed = archive(input);
		const metadata = join(input.home, ".git/candidate.json");
		const directory = join(input.home, ".git/release-artifact");
		writeFileSync(
			metadata,
			JSON.stringify({ tarball: packed.path, sha256: packed.sha256 }),
		);
		const result = artifactCommand(input, ["prepare", metadata, directory], {
			...input.env,
			[key]: "",
		});
		expect(result.code).not.toBe(0);
		expect(existsSync(directory)).toBe(false);
	});
});

function literalStage(
	input: ReturnType<typeof fixture>,
	packed: ReturnType<typeof preparedArtifact>,
	options: { token?: string; probe?: "config" } = {},
) {
	const bin = join(input.home, ".git/fake-bin");
	mkdirSync(bin);
	const fakeNpm = join(bin, "npm");
	writeFileSync(
		fakeNpm,
		`#!${process.execPath}\nconsole.log(JSON.stringify({ fakeNpm: true, argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME, userconfig: process.env.npm_config_userconfig, globalconfig: process.env.npm_config_globalconfig, cache: process.env.npm_config_cache, extraSecret: Boolean(process.env.UNEXPECTED_RELEASE_SECRET), publishingToken: Boolean(process.env.NODE_AUTH_TOKEN), oidc: Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN), source: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA, eventName: process.env.GITHUB_EVENT_NAME, repositoryId: process.env.GITHUB_REPOSITORY_ID, repositoryOwnerId: process.env.GITHUB_REPOSITORY_OWNER_ID }));\n`,
	);
	chmodSync(fakeNpm, 0o755);
	const yaml = Bun.YAML.parse(
		readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"),
	) as { jobs: { stage: { steps: { name?: string; run?: string }[] } } };
	let body = yaml.jobs.stage.steps.find(
		(item) => item.name === "Stage exact candidate",
	)?.run;
	if (!body) throw new Error("missing staging step");
	if (options.probe === "config") {
		const publish =
			'npm stage publish "$FGJ_PACKAGE_TARBALL" --access public --tag "$FGJ_RELEASE_DIST_TAG" --provenance --ignore-scripts --registry https://registry.npmjs.org';
		if (!body.includes(publish))
			throw new Error("missing literal npm staging command");
		body = body.replace(
			publish,
			"npm config get registry --registry https://registry.npmjs.org",
		);
	}
	const result = run(input.home, ["bash", "-e", "-o", "pipefail", "-c", body], {
		...input.env,
		...(options.probe ? {} : { PATH: `${bin}:${input.env.PATH}` }),
		RUNNER_TEMP: join(input.home, ".git"),
		FGJ_RELEASE_MODE: "stage",
		FGJ_RELEASE_REQUESTED_MODE: "stage",
		FGJ_PACKAGE_TARBALL: packed.candidate,
		FGJ_RELEASE_SHA256: packed.sha256,
		ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid",
		ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-do-not-print",
		UNEXPECTED_RELEASE_SECRET: "synthetic-extra-do-not-print",
		npm_config_userconfig: join(input.home, ".git/ambient-npmrc"),
		npm_config_globalconfig: join(input.home, ".git/ambient-global-npmrc"),
		...(options.token ? { NODE_AUTH_TOKEN: options.token } : {}),
	});
	return result;
}

describe("literal npm staging isolation without a registry request", () => {
	test("the installed npm accepts the isolated staging configuration without a registry request", () => {
		const input = fixture();
		const packed = preparedArtifact(input);
		const result = literalStage(input, packed, { probe: "config" });
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout.trim().split("\n").at(-1)).toBe(
			"https://registry.npmjs.org/",
		);
		expect(
			readdirSync(join(input.home, ".git")).some((name) =>
				name.startsWith("fgj-npm-stage."),
			),
		).toBe(false);
	});

	test("passes the same archive, explicit provenance and only the required environment to a fake npm", () => {
		const input = fixture();
		const packed = preparedArtifact(input);
		const result = literalStage(input, packed);
		expect(result.code, result.stderr).toBe(0);
		const record = JSON.parse(
			result.stdout.trim().split("\n").at(-1) as string,
		);
		expect(record).toMatchObject({
			fakeNpm: true,
			argv: [
				"stage",
				"publish",
				packed.candidate,
				"--access",
				"public",
				"--tag",
				"rc",
				"--provenance",
				"--ignore-scripts",
				"--registry",
				"https://registry.npmjs.org",
			],
			extraSecret: false,
			publishingToken: false,
			oidc: true,
			source: "example-owner/fgj",
			commit: input.commit,
			eventName: "workflow_dispatch",
			repositoryId: "202",
			repositoryOwnerId: "303",
		});
		expect(record.cwd).toBe(record.home);
		expect(record.cwd).not.toBe(input.home);
		expect(record.cache).toBe(join(record.home, "cache"));
		expect(record.userconfig).toBe(join(record.home, "npmrc"));
		expect(record.globalconfig).toBe(join(record.home, "global-npmrc"));
		expect(existsSync(record.home)).toBe(false);
		expect(result.stdout + result.stderr).not.toContain(
			"synthetic-oidc-do-not-print",
		);
		expect(result.stdout + result.stderr).not.toContain(
			"synthetic-extra-do-not-print",
		);
		expect(
			createHash("sha256").update(readFileSync(packed.candidate)).digest("hex"),
		).toBe(packed.sha256);
	});

	test("refuses an ambient npm token before calling even the fake npm", () => {
		const input = fixture();
		const packed = preparedArtifact(input);
		const result = literalStage(input, packed, {
			token: "synthetic-publishing-do-not-print",
		});
		expect(result.code).not.toBe(0);
		expect(result.stdout).not.toContain("fakeNpm");
		expect(result.stderr).toContain("Stage must have no npm publishing token");
		expect(result.stdout + result.stderr).not.toContain(
			"synthetic-publishing-do-not-print",
		);
	});
});

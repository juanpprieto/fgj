import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv, tempDir } from "../support/tmp.ts";

const ROOT = join(import.meta.dir, "../..");
const CHECKOUT = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const NODE = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const UPLOAD =
	"actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD =
	"actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const expression = (value: string) => `\${{ ${value} }}`;

type Step = {
	name?: string;
	id?: string;
	run?: string;
	uses?: string;
	with?: Record<string, unknown>;
	if?: string;
	"continue-on-error"?: boolean;
};
type Job = {
	"runs-on": string;
	"timeout-minutes": number;
	permissions: Record<string, string>;
	env?: Record<string, string>;
	needs?: string | string[];
	if?: string;
	environment?: unknown;
	outputs?: Record<string, string>;
	steps: Step[];
	"continue-on-error"?: boolean;
};
type Workflow = {
	name: string;
	on: Record<string, unknown>;
	permissions: Record<string, string>;
	defaults: unknown;
	concurrency: unknown;
	env: Record<string, string>;
	jobs: Record<"build" | "package-macos" | "stage", Job>;
};

function workflow(): Workflow {
	return Bun.YAML.parse(
		readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"),
	) as Workflow;
}

function step(job: Job, name: string): Step {
	const found = job.steps.find((item) => item.name === name);
	if (!found) throw new Error(`Missing step: ${name}`);
	return found;
}

function ordered(job: Job, names: string[]): void {
	let previous = -1;
	for (const name of names) {
		const index = job.steps.findIndex((item) => item.name === name);
		expect(index, name).toBeGreaterThan(previous);
		const item = job.steps[index];
		expect(item?.run, name).toBeDefined();
		expect(item?.if, name).toBeUndefined();
		previous = index;
	}
}

function safeRelease(input: Workflow): void {
	expect(Object.keys(input).sort()).toEqual([
		"concurrency",
		"defaults",
		"env",
		"jobs",
		"name",
		"on",
		"permissions",
	]);
	expect(input.name).toBe("release");
	expect(input.on).toEqual({
		workflow_dispatch: {
			inputs: {
				mode: {
					description: "Release mode",
					type: "choice",
					required: true,
					default: "dry-run",
					options: ["dry-run", "stage"],
				},
				dist_tag: {
					description: "Approved npm distribution tag",
					type: "choice",
					required: true,
					default: "rc",
					options: ["rc", "latest"],
				},
			},
		},
	});
	expect(input.permissions).toEqual({ contents: "read" });
	expect(input.defaults).toEqual({ run: { shell: "bash" } });
	expect(input.concurrency).toEqual({
		group: expression("github.repository").replace(/^/, "release-"),
		"cancel-in-progress": false,
	});
	expect(input.env).toEqual({
		CI: "1",
		FGJ_RELEASE_MODE: "dry-run",
		FGJ_RELEASE_REQUESTED_MODE: expression("inputs.mode"),
		FGJ_RELEASE_DIST_TAG: expression("inputs.dist_tag"),
	});
	expect(Object.keys(input.jobs).sort()).toEqual([
		"build",
		"package-macos",
		"stage",
	]);
	for (const [key, job] of Object.entries(input.jobs)) {
		expect(job["timeout-minutes"]).toBeGreaterThan(0);
		expect(job["timeout-minutes"]).toBeLessThanOrEqual(20);
		expect(job["continue-on-error"]).toBeUndefined();
		const fields = [
			"runs-on",
			"timeout-minutes",
			"permissions",
			"env",
			"steps",
		];
		if (key === "build") fields.push("outputs");
		if (key === "package-macos") fields.push("needs");
		if (key === "stage") fields.push("needs", "if", "environment");
		expect(Object.keys(job).sort()).toEqual(fields.sort());
		expect(job["runs-on"]).toBe(
			key === "package-macos" ? "macos-15" : "ubuntu-24.04-arm",
		);
		expect(job.permissions).toEqual(
			key === "stage"
				? { contents: "read", "id-token": "write" }
				: { contents: "read" },
		);
		expect(job.if).toBe(key === "stage" ? "inputs.mode == 'stage'" : undefined);
		expect(job.environment).toEqual(
			key === "stage" ? { name: "npm-stage" } : undefined,
		);
		for (const item of job.steps) {
			expect(item["continue-on-error"]).toBeUndefined();
			expect(
				Object.keys(item).every((field) =>
					["name", "id", "run", "uses", "with", "if"].includes(field),
				),
			).toBe(true);
			expect(item.if).toBe(
				item.name === "Stop owned test Forgejo" ? "always()" : undefined,
			);
			if (item.uses)
				expect([CHECKOUT, NODE, key === "build" ? UPLOAD : DOWNLOAD]).toContain(
					item.uses,
				);
			if (item.uses === CHECKOUT)
				expect(item.with).toEqual({
					ref: expression("github.sha"),
					"fetch-depth": 0,
					"persist-credentials": false,
				});
			if (item.uses === NODE)
				expect(item.with).toEqual({
					"node-version": "24.19.0",
					"package-manager-cache": false,
				});
			if (item.uses === DOWNLOAD)
				expect(item.with).toEqual({
					"artifact-ids": expression("needs.build.outputs.artifact-id"),
					path: `${expression("runner.temp")}/fgj-release`,
					"digest-mismatch": "error",
				});
			if (item.run) {
				expect(item.run).not.toContain("${{");
				expect(item.run).not.toMatch(
					/npm\s+(?:publish|dist-tag|stage\s+(?:approve|reject|download|list|view))\b|install:(?:local|uat)|\|\||exit 0|set \+e/,
				);
				if (key !== "stage")
					expect(item.run).not.toMatch(
						/npm\s+stage\b|ACTIONS_ID_TOKEN_REQUEST/,
					);
			}
		}
		const text = job.steps.map((item) => item.run ?? "").join("\n");
		expect(text).toContain("npm@11.17.0");
		expect(text).toContain("bun@1.3.14");
		expect(text).toContain('test "$(node --version)" = v24.19.0');
		expect(text).toContain('test "$(npm --version)" = 11.17.0');
		expect(text).toContain('test "$(bun --version)" = 1.3.14');
		ordered(job, ["Verify release source"]);
	}
	expect(JSON.stringify(input)).not.toMatch(
		/secrets\.|vars\.|self-hosted|actions\/cache|NODE_AUTH_TOKEN|NPM_TOKEN|provenance-file/,
	);
	const build = input.jobs.build;
	expect(build.env).toEqual({
		FGJ_TEST_WORKERS: "1",
		FGJ_FORGEJO_PORT: "49381",
	});
	expect(build.outputs).toEqual({
		"artifact-id": expression("steps.archive.outputs.artifact-id"),
		sha256: expression("steps.candidate.outputs.sha256"),
	});
	ordered(build, [
		"Verify release source",
		"Install locked dependencies",
		"Build one release candidate",
		"Bind candidate bytes",
		"Check source, server and harness rules",
		"Record installation matrix and privacy checks",
		"Read through the npm-installed candidate",
		"Verify tested bytes",
	]);
	expect(step(build, "Verify release source").run).toBe(
		"bun scripts/release-check.ts",
	);
	expect(step(build, "Install locked dependencies").run).toBe(
		"bun install --frozen-lockfile",
	);
	expect(step(build, "Build one release candidate").run).toBe(
		'bun run package --release > "$RUNNER_TEMP/fgj-candidate.json"',
	);
	expect(step(build, "Bind candidate bytes").id).toBe("candidate");
	expect(step(build, "Bind candidate bytes").run).toBe(
		'bun scripts/release-artifact.ts prepare "$RUNNER_TEMP/fgj-candidate.json" "$RUNNER_TEMP/fgj-release"',
	);
	expect(step(build, "Check source, server and harness rules").run).toBe(
		"bun run check",
	);
	expect(step(build, "Record installation matrix and privacy checks").run).toBe(
		"bun test test/unit/package.test.ts test/unit/public.test.ts --only-failures",
	);
	expect(step(build, "Read through the npm-installed candidate").run).toBe(
		"bun test test/server/package.test.ts",
	);
	expect(step(build, "Verify tested bytes").run).toBe(
		'bun scripts/release-artifact.ts verify "$RUNNER_TEMP/fgj-release" "$FGJ_RELEASE_SHA256"',
	);
	expect(step(build, "Stop owned test Forgejo").run).toBe(
		"bun run forgejo:stop",
	);
	const upload = build.steps.find((item) => item.uses === UPLOAD);
	expect(upload?.id).toBe("archive");
	expect(upload?.with).toEqual({
		name: `fgj-release-${expression("github.run_id")}-${expression("github.run_attempt")}`,
		path: `${expression("runner.temp")}/fgj-release`,
		"if-no-files-found": "error",
		"retention-days": 7,
		overwrite: false,
		"include-hidden-files": false,
	});
	expect(build.steps.indexOf(upload as Step)).toBeGreaterThan(
		build.steps.indexOf(step(build, "Verify tested bytes")),
	);
	const mac = input.jobs["package-macos"];
	expect(mac.needs).toBe("build");
	expect(mac.env).toEqual({
		FGJ_RELEASE_SHA256: expression("needs.build.outputs.sha256"),
	});
	ordered(mac, [
		"Verify release source",
		"Install locked dependencies",
		"Verify candidate bytes",
		"Record installation matrix and privacy checks",
	]);
	expect(step(mac, "Verify candidate bytes").run).toBe(
		'bun scripts/release-artifact.ts verify "$RUNNER_TEMP/fgj-release" "$FGJ_RELEASE_SHA256"',
	);
	expect(step(mac, "Record installation matrix and privacy checks").run).toBe(
		"bun test test/unit/package.test.ts test/unit/public.test.ts --only-failures",
	);
	const stage = input.jobs.stage;
	expect(stage.needs).toEqual(["build", "package-macos"]);
	expect(stage.env).toEqual({
		FGJ_RELEASE_MODE: "stage",
		FGJ_RELEASE_SHA256: expression("needs.build.outputs.sha256"),
	});
	ordered(stage, [
		"Verify release source",
		"Verify candidate bytes",
		"Stage exact candidate",
	]);
	expect(step(stage, "Verify candidate bytes").run).toBe(
		'bun scripts/release-artifact.ts verify "$RUNNER_TEMP/fgj-release" "$FGJ_RELEASE_SHA256"',
	);
	const publish = step(stage, "Stage exact candidate").run as string;
	expect(
		publish.startsWith(
			'bun scripts/release-artifact.ts verify "$RUNNER_TEMP/fgj-release" "$FGJ_RELEASE_SHA256"\n',
		),
	).toBe(true);
	expect(publish).toContain("trap 'rm -rf \"$release_home\"' EXIT");
	expect(publish).toContain('cd "$release_home"');
	expect(publish).toContain("env -i");
	for (const value of [
		': > "$release_home/npmrc"',
		': > "$release_home/global-npmrc"',
		'npm_config_userconfig="$release_home/npmrc"',
		'npm_config_globalconfig="$release_home/global-npmrc"',
		'GITHUB_EVENT_NAME="$GITHUB_EVENT_NAME"',
		'GITHUB_REPOSITORY_ID="$GITHUB_REPOSITORY_ID"',
		'GITHUB_REPOSITORY_OWNER_ID="$GITHUB_REPOSITORY_OWNER_ID"',
		'npm_config_cache="$release_home/cache"',
		"ACTIONS_ID_TOKEN_REQUEST_TOKEN=",
		"ACTIONS_ID_TOKEN_REQUEST_URL=",
	])
		expect(publish).toContain(value);
	expect(publish).toContain(
		'npm stage publish "$FGJ_PACKAGE_TARBALL" --access public --tag "$FGJ_RELEASE_DIST_TAG" --provenance --ignore-scripts --registry https://registry.npmjs.org',
	);
	for (const job of [mac, stage]) {
		expect(job.steps.filter((item) => item.uses === DOWNLOAD)).toHaveLength(1);
		expect(job.steps.findIndex((item) => item.uses === DOWNLOAD)).toBeLessThan(
			job.steps.indexOf(step(job, "Verify candidate bytes")),
		);
		expect(job.steps.map((item) => item.run ?? "").join("\n")).not.toMatch(
			/bun run package|npm pack|bun run build/,
		);
	}
}

describe("manual release workflow", () => {
	test("limits staging to the owner-dispatched protected release run", () =>
		safeRelease(workflow()));
	test.each([
		"push",
		"pull_request",
		"pull_request_target",
		"workflow_run",
		"workflow_call",
		"issue_comment",
		"release",
	])("refuses trigger %s", (event) => {
		const input = workflow();
		input.on[event] = {};
		expect(() => safeRelease(input)).toThrow();
	});
	test.each(["build", "package-macos", "stage"] as const)(
		"refuses ignored job failures in %s",
		(key) => {
			const input = workflow();
			input.jobs[key]["continue-on-error"] = true;
			expect(() => safeRelease(input)).toThrow();
		},
	);
	test.each([
		"Check source, server and harness rules",
		"Verify tested bytes",
		"Record installation matrix and privacy checks",
	])("refuses disabled Linux step %s", (name) => {
		const input = workflow();
		step(input.jobs.build, name).if = "false";
		expect(() => safeRelease(input)).toThrow();
	});
	test.each([
		"stage by default",
		"cancel active run",
		"OIDC in build",
		"OIDC in Mac",
		"missing environment",
		"missing Mac dependency",
		"unconditional staging",
		"writable checkout",
		"no history",
		"Node cache",
		"artifact overwrite",
		"hidden files",
		"cross-run artifact",
		"artifact warning",
		"build in stage",
		"direct publish",
		"no provenance",
		"inherited npm config",
		"duplicate npm config paths",
		"missing GITHUB_EVENT_NAME",
		"missing GITHUB_REPOSITORY_ID",
		"missing GITHUB_REPOSITORY_OWNER_ID",
		"ignored stage failure",
	])("refuses %s", (change) => {
		const input = workflow();
		const build = input.jobs.build;
		const stage = input.jobs.stage;
		const publisher = step(stage, "Stage exact candidate");
		if (!publisher.run) throw new Error("Missing staging command");
		const checkout = step(stage, "Checkout reviewed source");
		const node = step(stage, "Set up Node");
		const download = step(stage, "Download this run's candidate");
		const upload = step(build, "Retain checked candidate");
		if (change === "stage by default")
			(
				input.on.workflow_dispatch as { inputs: { mode: { default: string } } }
			).inputs.mode.default = "stage";
		if (change === "cancel active run")
			input.concurrency = {
				group: expression("github.repository").replace(/^/, "release-"),
				"cancel-in-progress": true,
			};
		if (change === "OIDC in build") build.permissions["id-token"] = "write";
		if (change === "OIDC in Mac")
			input.jobs["package-macos"].permissions["id-token"] = "write";
		if (change === "missing environment") delete stage.environment;
		if (change === "missing Mac dependency") stage.needs = ["build"];
		if (change === "unconditional staging") stage.if = "always()";
		if (change === "writable checkout")
			checkout.with = { ...checkout.with, "persist-credentials": true };
		if (change === "no history")
			checkout.with = { ...checkout.with, "fetch-depth": 1 };
		if (change === "Node cache") node.with = { ...node.with, cache: "npm" };
		if (change === "artifact overwrite")
			upload.with = { ...upload.with, overwrite: true };
		if (change === "hidden files")
			upload.with = { ...upload.with, "include-hidden-files": true };
		if (change === "cross-run artifact")
			download.with = { ...download.with, "run-id": "123" };
		if (change === "artifact warning")
			download.with = { ...download.with, "digest-mismatch": "warn" };
		if (change === "build in stage")
			stage.steps.push({ run: "bun run package --release" });
		if (change === "direct publish")
			publisher.run = publisher.run.replace("npm stage publish", "npm publish");
		if (change === "no provenance")
			publisher.run = publisher.run.replace(" --provenance", "");
		if (change === "inherited npm config")
			publisher.run = publisher.run.replace("env -i", "env");
		if (change === "duplicate npm config paths")
			publisher.run = publisher.run.replace(
				'npm_config_globalconfig="$release_home/global-npmrc"',
				'npm_config_globalconfig="$release_home/npmrc"',
			);
		if (change.startsWith("missing GITHUB_")) {
			const key = change.slice("missing ".length);
			publisher.run = publisher.run.replace(`${key}="$${key}"`, "");
		}
		if (change === "ignored stage failure")
			publisher["continue-on-error"] = true;
		expect(() => safeRelease(input)).toThrow();
	});
});

test("native rehearsal stays private, manual, read-only and bounded", () => {
	const native = Bun.YAML.parse(
		readFileSync(join(ROOT, ".github/workflows/native-rehearsal.yml"), "utf8"),
	) as {
		on: Record<string, unknown>;
		permissions: Record<string, string>;
		jobs: Record<
			string,
			Job & {
				strategy: {
					matrix: { include: { runner: string; platform: string }[] };
				};
			}
		>;
	};
	expect(Object.keys(native.on)).toEqual(["workflow_dispatch"]);
	expect(native.permissions).toEqual({ contents: "read" });
	expect(Object.keys(native.jobs)).toEqual(["native"]);
	const job = native.jobs.native as NonNullable<typeof native.jobs.native>;
	expect(job.if).toBe(
		"github.event.repository.private && github.actor == github.repository_owner && github.triggering_actor == github.repository_owner",
	);
	expect(job.permissions).toEqual({ contents: "read" });
	expect(job["timeout-minutes"]).toBe(20);
	expect(job.strategy.matrix.include).toEqual([
		{ runner: "ubuntu-24.04-arm", platform: "linux-arm64" },
		{ runner: "macos-15", platform: "macos-arm64" },
	]);
	for (const item of job.steps) {
		expect(item["continue-on-error"]).toBeUndefined();
		if (item.uses)
			expect([CHECKOUT, NODE, UPLOAD, DOWNLOAD]).toContain(item.uses);
	}
	expect(step(job, "Checkout approved source").with).toEqual({
		ref: expression("github.sha"),
		"fetch-depth": 0,
		"persist-credentials": false,
	});
	const guard = step(job, "Check source identity").run;
	for (const check of [
		'test "$GITHUB_REF" = refs/heads/main',
		'test "$EXPECTED_SHA" = "$GITHUB_SHA"',
		'test "$GITHUB_WORKFLOW_SHA" = "$GITHUB_SHA"',
		'git merge-base --is-ancestor "$EXPECTED_SHA" origin/main',
	])
		expect(guard).toContain(check);
	expect(step(job, "Download the exact uploaded artifact").with).toEqual({
		"artifact-ids": expression("steps.archive.outputs.artifact-id"),
		path: `${expression("runner.temp")}/downloaded-native`,
		"digest-mismatch": "error",
	});
	expect(step(job, "Retain private candidate").with?.["retention-days"]).toBe(
		7,
	);
	expect(step(job, "Retain private candidate").with?.overwrite).toBe(false);
	expect(step(job, "Verify downloaded bytes and native startup").run).toContain(
		"process.env.CANDIDATE_SHA256",
	);
	expect(step(job, "Test native setup and first read on Linux").run).toContain(
		"bun test test/server/getting-started.test.ts",
	);
	expect(step(job, "Stop owned Linux fixture").if).toBe(
		"always() && runner.os == 'Linux'",
	);
});

test.each([false, true])(
	"native download verification executes with corrupt=%s",
	async (corrupt) => {
		const native = Bun.YAML.parse(
			readFileSync(
				join(ROOT, ".github/workflows/native-rehearsal.yml"),
				"utf8",
			),
		) as { jobs: { native: Job } };
		const script = step(
			native.jobs.native,
			"Verify downloaded bytes and native startup",
		).run as string;
		const code = /bun -e '([\s\S]*?)'/.exec(script)?.[1] as string;
		const home = tempDir("fgj-native-download-");
		const name = "candidate.tar.gz";
		const bytes = "synthetic archive bytes";
		const sha = Bun.CryptoHasher.hash("sha256", bytes, "hex");
		await Bun.write(join(home, name), corrupt ? "changed bytes" : bytes);
		await Bun.write(
			join(home, "candidate.json"),
			JSON.stringify({
				sha256: sha,
				source_sha: "source",
				workflow_sha: "source",
				run_id: "1",
				run_attempt: "1",
			}),
		);
		const result = Bun.spawnSync([process.execPath, "-e", code], {
			cwd: home,
			env: {
				...cleanEnv(home),
				CANDIDATE_NAME: name,
				CANDIDATE_SHA256: sha,
				EXPECTED_SHA: "source",
				GITHUB_WORKFLOW_SHA: "source",
				GITHUB_RUN_ID: "1",
				GITHUB_RUN_ATTEMPT: "1",
			},
		});
		expect(result.exitCode, result.stderr.toString()).toBe(corrupt ? 1 : 0);
	},
);

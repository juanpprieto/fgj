import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const CHECKOUT = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const NODE = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";

type Step = {
	"continue-on-error"?: boolean;
	if?: string;
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
	env?: Record<string, unknown>;
};
type Job = {
	"continue-on-error"?: boolean;
	if?: string;
	"runs-on": string;
	"timeout-minutes": number;
	permissions: Record<string, string>;
	steps: Step[];
	environment?: unknown;
	secrets?: unknown;
};
type Workflow = {
	on: Record<string, unknown>;
	permissions: Record<string, string>;
	concurrency: { group: string; "cancel-in-progress": boolean };
	jobs: Record<"check" | "package-macos", Job>;
};

function workflow(): Workflow {
	return Bun.YAML.parse(
		readFileSync(join(ROOT, ".github/workflows/contributor.yml"), "utf8"),
	) as Workflow;
}

function safeContributor(input: Workflow): void {
	expect(Object.keys(input.on).sort()).toEqual(["pull_request", "push"]);
	expect(input.on.push).toEqual({ branches: ["main"] });
	expect(input.permissions).toEqual({ contents: "read" });
	expect(input.concurrency).toEqual({
		// This is a GitHub expression, not a JavaScript template.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
		group: "contributor-${{ github.ref }}",
		"cancel-in-progress": true,
	});
	expect(Object.keys(input.jobs).sort()).toEqual(["check", "package-macos"]);
	for (const job of Object.values(input.jobs)) {
		expect(job.if).toBeUndefined();
		expect([undefined, false]).toContain(job["continue-on-error"]);
		expect(["ubuntu-24.04-arm", "macos-15"]).toContain(job["runs-on"]);
		expect(job["timeout-minutes"]).toBeGreaterThan(0);
		expect(job["timeout-minutes"]).toBeLessThanOrEqual(20);
		expect(job.permissions).toEqual({ contents: "read" });
		expect(job.environment).toBeUndefined();
		expect(job.secrets).toBeUndefined();
		for (const step of job.steps) {
			if (step.uses) expect([CHECKOUT, NODE]).toContain(step.uses);
			if (step.run) {
				expect(step.run).not.toContain("${{");
				expect(step.run).not.toMatch(
					/npm\s+(?:stage|publish|dist-tag)|install:(?:local|uat)|forgejo-browser/,
				);
			}
			if (step.uses === CHECKOUT)
				expect(step.with?.["persist-credentials"]).toBe(false);
			if (step.uses === NODE) {
				expect(step.with?.["node-version"]).toBe("24.19.0");
				expect(step.with?.["package-manager-cache"]).toBe(false);
				expect(step.with?.cache).toBeUndefined();
				expect(step.with?.["registry-url"]).toBeUndefined();
			}
		}
	}
	orderedChecks(input.jobs.check, [
		"Build one candidate and retain its path",
		"Check source, server and harness rules",
		"Record installation matrix and privacy checks",
		"Read through the npm-installed candidate",
	]);
	orderedChecks(input.jobs["package-macos"], [
		"Build one candidate and retain its path",
		"Record installation matrix and privacy checks",
	]);
	expect(JSON.stringify(input)).not.toMatch(
		/secrets\.|ACTIONS_ID_TOKEN_REQUEST|NODE_AUTH_TOKEN|NPM_TOKEN|id-token|self-hosted|workflow_run|pull_request_target|actions\/(?:cache|upload-artifact|download-artifact)/,
	);
}

function orderedChecks(job: Job, names: string[]): void {
	let previous = -1;
	for (const name of names) {
		const index = job.steps.findIndex((step) => step.name === name);
		expect(index, name).toBeGreaterThan(previous);
		const step = job.steps[index];
		expect(step?.run, name).toBeDefined();
		expect(step?.if, name).toBeUndefined();
		expect([undefined, false], name).toContain(step?.["continue-on-error"]);
		previous = index;
	}
}

function commands(job: Job): string {
	return job.steps.map((step) => step.run ?? "").join("\n");
}

describe("contributor workflow", () => {
	test("keeps contributor execution read-only and separate from release authority", () => {
		safeContributor(workflow());
	});
	test("runs full server and harness checks on hosted Linux arm64", () => {
		const job = workflow().jobs.check;
		expect(job["runs-on"]).toBe("ubuntu-24.04-arm");
		const text = commands(job);
		expect(text).toContain("bun@1.3.14");
		expect(text).toContain("npm@11.17.0");
		expect(text).toContain("@openai/codex@0.155.1");
		expect(text).toContain("@earendil-works/pi-coding-agent@0.87.1");
		expect(text).toContain("bun install --frozen-lockfile");
		expect(text).toContain("bun run check");
		expect(text).toContain("test/server/package.test.ts");
		expect(text).toContain("bun run forgejo:stop");
		expect(
			job.steps.some(
				(step) =>
					step.name === "Stop owned test Forgejo" && step.if === "always()",
			),
		).toBe(true);
	});
	test("keeps hosted macOS package checks free of Podman server requirements", () => {
		const job = workflow().jobs["package-macos"];
		expect(job["runs-on"]).toBe("macos-15");
		const text = commands(job);
		expect(text).toContain("test/unit/package.test.ts");
		expect(text).toContain("test/unit/public.test.ts");
		expect(text).not.toMatch(/podman|forgejo:start|bun run check|test\/server/);
	});
	test("builds one candidate per job and reuses its metadata-derived path", () => {
		for (const job of Object.values(workflow().jobs)) {
			const text = commands(job);
			expect(text.match(/bun run package\b/g)).toHaveLength(1);
			expect(text).toContain("FGJ_PACKAGE_TARBALL");
			expect(text).toContain("GITHUB_ENV");
			expect(text).not.toContain("fgj-0.1.0.tgz");
		}
	});
	test.each(["check", "package-macos"] as const)(
		"refuses explicit setup-node caching in %s",
		(key) => {
			const input = workflow();
			const node = input.jobs[key].steps.find((step) => step.uses === NODE);
			if (!node?.with) throw new Error("missing Node setup inputs");
			node.with.cache = "npm";
			expect(() => safeContributor(input)).toThrow();
		},
	);
	test.each(["check", "package-macos"] as const)(
		"refuses a condition that disables job %s",
		(key) => {
			const input = workflow();
			input.jobs[key].if = "false";
			expect(() => safeContributor(input)).toThrow();
		},
	);
	test.each(["check", "package-macos"] as const)(
		"refuses ignored failures in job %s",
		(key) => {
			const input = workflow();
			input.jobs[key]["continue-on-error"] = true;
			expect(() => safeContributor(input)).toThrow();
		},
	);
	test.each(["check", "package-macos"] as const)(
		"refuses ignored package-check failures in %s",
		(key) => {
			const input = workflow();
			const step = input.jobs[key].steps.find(
				(step) => step.name === "Record installation matrix and privacy checks",
			);
			if (!step) throw new Error("missing package check step");
			step["continue-on-error"] = true;
			expect(() => safeContributor(input)).toThrow();
		},
	);
	test.each([
		["check", "Build one candidate and retain its path"],
		["check", "Check source, server and harness rules"],
		["check", "Record installation matrix and privacy checks"],
		["check", "Read through the npm-installed candidate"],
		["package-macos", "Build one candidate and retain its path"],
		["package-macos", "Record installation matrix and privacy checks"],
	] as const)("refuses a disabled %s step: %s", (key, name) => {
		const input = workflow();
		const step = input.jobs[key].steps.find((step) => step.name === name);
		if (!step) throw new Error("missing required step");
		step.if = "false";
		expect(() => safeContributor(input)).toThrow();
	});
	test.each(["check", "package-macos"] as const)(
		"refuses checks before candidate creation in %s",
		(key) => {
			const input = workflow();
			const steps = input.jobs[key].steps;
			const build = steps.findIndex(
				(step) => step.name === "Build one candidate and retain its path",
			);
			const checks = steps.findIndex(
				(step) =>
					step.name ===
					(key === "check"
						? "Check source, server and harness rules"
						: "Record installation matrix and privacy checks"),
			);
			const builder = steps[build];
			const checker = steps[checks];
			if (!builder || !checker) throw new Error("missing build or check step");
			steps[build] = checker;
			steps[checks] = builder;
			expect(() => safeContributor(input)).toThrow();
		},
	);
	test.each(["pull_request_target", "workflow_run", "issue_comment"])(
		"refuses privileged trigger %s",
		(event) => {
			const input = workflow();
			input.on[event] = {};
			expect(() => safeContributor(input)).toThrow();
		},
	);
	test.each([
		"environment",
		"oidc",
		"writable token",
		"secrets",
		"npm staging",
		"direct publication",
		"self-hosted",
		"persisted credentials",
		"mutable action",
		"cache",
		"shell interpolation",
	])("policy assertions refuse %s", (change) => {
		const input = workflow();
		const job = input.jobs.check;
		if (change === "environment") job.environment = "release";
		if (change === "oidc") job.permissions["id-token"] = "write";
		if (change === "writable token") job.permissions.contents = "write";
		if (change === "secrets") job.secrets = "inherit";
		if (change === "npm staging")
			job.steps.push({ run: "npm stage publish candidate.tgz" });
		if (change === "direct publication")
			job.steps.push({ run: "npm publish candidate.tgz" });
		if (change === "self-hosted") job["runs-on"] = "self-hosted";
		if (change === "persisted credentials") {
			const checkout = job.steps.find((step) => step.uses === CHECKOUT);
			if (!checkout?.with) throw new Error("missing checkout inputs");
			checkout.with["persist-credentials"] = true;
		}
		if (change === "mutable action")
			job.steps.push({ uses: "actions/checkout@v6" });
		if (change === "cache")
			job.steps.push({ uses: `actions/cache@${"0".repeat(40)}` });
		if (change === "shell interpolation")
			job.steps.push({
				// biome-ignore lint/suspicious/noTemplateCurlyInString: hostile workflow fixture
				run: "echo ${{ github.event.pull_request.title }}",
			});
		expect(() => safeContributor(input)).toThrow();
	});
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bunLine, failLines, runStep } from "../../scripts/check.ts";
import {
	containerName,
	filterLogText,
	filterSince,
	parseLog,
} from "../../scripts/forgejo-logs.ts";
import { pending } from "../../scripts/install-uat.ts";
import {
	childEnv,
	sameRepo,
	treeChanged,
	uatArgs,
	versionProblem,
} from "../../scripts/uat-shell.ts";
import { originUrl } from "../../src/forgejo/target.ts";
import { cleanEnv, tempDir } from "../support/tmp.ts";

describe("uat:shell", () => {
	const root = "/r/fgj";
	const at = ["--cwd", "/tmp/uat"];

	test("reads --cwd, --profile, and the command, with or without the -- that bun run drops", () => {
		expect(
			uatArgs(
				[...at, "--profile", "agent-codex", "--", "codex", "exec", "hi"],
				root,
			),
		).toEqual({
			cwd: "/tmp/uat",
			profile: "agent-codex",
			command: ["codex", "exec", "hi"],
		});
		expect(uatArgs([...at, "--", "pi"], root)).toEqual({
			cwd: "/tmp/uat",
			command: ["pi"],
		});
		// The command's own flags belong to the command.
		expect(uatArgs([...at, "codex", "--json"], root).command).toEqual([
			"codex",
			"--json",
		]);
	});

	test("refuses a missing command or --cwd, an unknown or repeated flag, and a bad profile", () => {
		for (const argv of [
			[],
			[...at],
			[...at, "--"],
			["pi"],
			["--cwd", "--", "pi"],
			["--cwd", "rel/dir", "pi"],
			[...at, "--dirty", "--", "pi"],
			[...at, "--profile", "--", "pi"],
			[...at, "--profile", "-lead", "--", "pi"],
			[...at, "--profile", "a", "--profile", "b", "pi"],
		]) {
			expect(() => uatArgs(argv, root)).toThrow();
		}
	});

	test("--cwd must be outside the checkout, so a call without --repo cannot reach this repository", () => {
		for (const cwd of [
			root,
			`${root}/docs`,
			`${root}/../fgj/x`,
			`${root}/..x`,
		]) {
			expect(() => uatArgs(["--cwd", cwd, "pi"], root)).toThrow("inside");
		}
		// A sibling folder that only starts with the same letters is outside.
		expect(uatArgs(["--cwd", `${root}-uat`, "pi"], root).cwd).toBe(
			`${root}-uat`,
		);
	});

	test("another clone of the same repository counts as this repository, in any URL form", () => {
		const ssh = "git@git.example.com:alice/fgj.git";
		expect(sameRepo(ssh, "https://git.example.com/alice/fgj")).toBe(true);
		expect(sameRepo(ssh, "https://git.example.com/Alice/FGJ.git")).toBe(true);
		expect(sameRepo(ssh, "git@git.example.com:alice/fgj-sandbox.git")).toBe(
			false,
		);
		expect(sameRepo(ssh, "git@other.example.com:alice/fgj.git")).toBe(false);
		expect(sameRepo(null, ssh)).toBe(false);
		expect(sameRepo(null, null)).toBe(false);
	});

	test("puts dist first on PATH, removes what bun run adds, and sets FGJ_PROFILE only when asked", () => {
		const env = {
			PATH: `${root}/node_modules/.bin:${root}:/usr/bin:${root}-uat/bin`,
			HOME: "/h",
			FGJ_PROFILE: "lead",
			npm_lifecycle_event: "uat:shell",
		};
		expect(childEnv(env, `${root}/dist`, root)).toEqual({
			PATH: `${root}/dist:/usr/bin:${root}-uat/bin`,
			HOME: "/h",
			FGJ_PROFILE: "lead",
		});
		expect(childEnv(env, `${root}/dist`, root, "agent-codex").FGJ_PROFILE).toBe(
			"agent-codex",
		);
		expect(env.PATH).toStartWith(`${root}/node_modules/.bin`);
	});

	test("any changed, staged, or untracked file counts as a changed tree", () => {
		expect(treeChanged("")).toBe(false);
		expect(treeChanged("\n")).toBe(false);
		for (const line of [" M a.ts", "A  b.ts", "?? c.ts"]) {
			expect(treeChanged(`${line}\n`)).toBe(true);
		}
	});

	test("the child fgj must name HEAD, with no -dirty", () => {
		expect(versionProblem("0.1.0+9ba7ddb", "9ba7ddb")).toBeUndefined();
		expect(versionProblem("0.1.0+9ba7ddb-dirty", "9ba7ddb")).toContain("dirty");
		expect(versionProblem("0.1.0+861b84b", "9ba7ddb")).toContain("9ba7ddb");
		expect(versionProblem(undefined, "9ba7ddb")).toBeDefined();
	});

	test("the script refuses bad input before any build, with exit 125", () => {
		const run = (...argv: string[]) =>
			Bun.spawnSync(["bun", "scripts/uat-shell.ts", ...argv], {
				cwd: `${import.meta.dir}/../..`,
				stdout: "pipe",
				stderr: "pipe",
			});
		const none = run();
		expect(none.exitCode).toBe(125);
		expect(JSON.parse(none.stderr.toString()).error).toContain("command");
		const missing = run("--cwd", "/nonexistent-fgj-uat", "pi");
		expect(missing.exitCode).toBe(125);
		expect(JSON.parse(missing.stderr.toString()).error).toContain(
			"not a directory",
		);
	});

	const origin = originUrl(`${import.meta.dir}/../..`);
	test.if(origin !== null)(
		"the script refuses a --cwd in another clone with this origin, before any build",
		() => {
			const clone = tempDir("fgj-uat-clone-");
			const git = (...argv: string[]) =>
				Bun.spawnSync(["git", ...argv], { cwd: clone });
			git("init", "-q");
			git("remote", "add", "origin", origin as string);
			const r = Bun.spawnSync(
				["bun", "scripts/uat-shell.ts", "--cwd", clone, "true"],
				{ cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" },
			);
			expect(r.exitCode).toBe(125);
			expect(JSON.parse(r.stderr.toString()).error).toContain("clone");
		},
	);
});

describe("test server naming", () => {
	test("the container name carries the port, so two worktrees do not collide", () => {
		expect(containerName("3917")).toBe("fgj-forgejo-test-3917");
		expect(containerName("3918")).toBe("fgj-forgejo-test-3918");
	});
});

describe("server log time window", () => {
	// Forgejo writes local time as YYYY/MM/DD HH:MM:SS.
	const local = (d: Date) => {
		const p = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	};
	const now = new Date("2026-09-24T12:00:00Z");
	const old = new Date(now.getTime() - 30 * 60_000);
	const recent = new Date(now.getTime() - 60_000);
	const text = [
		`${local(old)} routers/x.go:1:f() [I] router: completed GET /api/v1/old for 1.2.3.4:0, 404 Not Found in 1.0ms`,
		`${local(recent)} routers/x.go:1:f() [I] router: completed GET /api/v1/new for 1.2.3.4:0, 404 Not Found in 1.0ms`,
	].join("\n");

	test("an RFC 3339 since keeps only later lines", () => {
		const since = new Date(now.getTime() - 5 * 60_000).toISOString();
		const kept = filterSince(parseLog(text), since, now);
		expect(kept.map((l) => ("path" in l ? l.path : ""))).toEqual([
			"/api/v1/new",
		]);
	});

	test("a duration since such as 10m keeps only later lines", () => {
		const kept = filterSince(parseLog(text), "10m", now);
		expect(kept).toHaveLength(1);
	});

	test("a line in the same second as since is kept (logs have whole seconds)", () => {
		const since = new Date(recent.getTime() + 100).toISOString();
		expect(filterSince(parseLog(text), since, now)).toHaveLength(1);
	});

	test("raw log text uses the same window as parsed lines", () => {
		const since = new Date(recent.getTime() + 100).toISOString();
		expect(filterLogText(text, since, now).split("\n")).toHaveLength(1);
		expect(filterLogText(text, since, now)).toContain("/api/v1/new");
	});

	test("lines with no time stay, so nothing is hidden by a parse failure", () => {
		const kept = filterSince(parseLog("free text line"), "10m", now);
		expect(kept).toHaveLength(1);
	});
});

describe("check steps", () => {
	test("a step whose command cannot start is a failed step, not a crash", async () => {
		const line = await runStep({
			name: "probe",
			cmd: ["/nonexistent/fgj-no-such-command"],
		});
		expect(line).toMatchObject({ step: "probe", ok: false });
		expect(String(line.out)).toMatch(/ENOENT|no such file/i);
	});

	test("a step ends when its command exits, even if a child it left keeps the output open", async () => {
		// The background sleep holds stdout open after the shell exits, as a
		// process that a timed-out test leaves behind can.
		const started = performance.now();
		const line = await runStep({
			name: "probe",
			cmd: ["sh", "-c", "sleep 8 & echo done; exit 3"],
		});
		expect(performance.now() - started).toBeLessThan(4000);
		expect(line).toMatchObject({ step: "probe", ok: false, code: 3 });
		expect(String(line.out)).toContain("done");
	});
});

describe("pinned Bun", () => {
	test("another Bun stops the check with the pinned version and a fix", () => {
		expect(bunLine("1.4.2", "1.3.14")).toEqual({
			step: "bun",
			ok: false,
			out: expect.stringContaining(
				"Bun 1.4.2 runs this check; the repository pins Bun 1.3.14.",
			),
			fix: "mise exec -- bun run check",
		});
	});

	test("the pinned Bun passes, and package.json, mise.toml, and CI pin the same one", async () => {
		const pinned = (await Bun.file("package.json").json()).devDependencies[
			"@types/bun"
		];
		expect(bunLine(pinned, pinned)).toBeUndefined();
		expect(await Bun.file("mise.toml").text()).toContain(`bun = "${pinned}"`);
		const workflows = [".github/workflows/contributor.yml"];
		const privateWorkflow = ".forgejo/workflows/ci.yml";
		if (await Bun.file(privateWorkflow).exists())
			workflows.push(privateWorkflow);
		for (const workflow of workflows) {
			const versions = [
				...(await Bun.file(workflow).text()).matchAll(/\bbun@(\S+)/g),
			].map((match) => match[1]);
			expect(versions.length, workflow).toBeGreaterThan(0);
			for (const version of versions) expect(version, workflow).toBe(pinned);
		}
	});
	test.each([
		{
			name: "public-only",
			publicVersions: ["pinned"],
			privateVersion: undefined,
			ok: true,
		},
		{
			name: "public and private",
			publicVersions: ["pinned"],
			privateVersion: "pinned",
			ok: true,
		},
		{
			name: "wrong public pin",
			publicVersions: ["wrong"],
			privateVersion: "pinned",
			ok: false,
		},
		{
			name: "mixed public pins",
			publicVersions: ["pinned", "wrong"],
			privateVersion: "pinned",
			ok: false,
		},
		{
			name: "extended public pin",
			publicVersions: ["extended"],
			privateVersion: "pinned",
			ok: false,
		},
		{
			name: "missing public CI",
			publicVersions: undefined,
			privateVersion: "pinned",
			ok: false,
		},
		{
			name: "missing public pin",
			publicVersions: [],
			privateVersion: "pinned",
			ok: false,
		},
		{
			name: "wrong private pin",
			publicVersions: ["pinned"],
			privateVersion: "wrong",
			ok: false,
		},
	])(
		"checkout fixture: $name",
		async ({ publicVersions, privateVersion, ok }) => {
			const root = tempDir("fgj-ci-pin-");
			const pinned = (
				await Bun.file(join(import.meta.dir, "../../package.json")).json()
			).devDependencies["@types/bun"];
			const version = (name: string) =>
				name === "pinned"
					? pinned
					: name === "extended"
						? `${pinned}0`
						: "0.0.0";
			await Bun.write(
				join(root, "package.json"),
				JSON.stringify({ devDependencies: { "@types/bun": pinned } }),
			);
			await Bun.write(join(root, "mise.toml"), `[tools]\nbun = "${pinned}"\n`);
			if (publicVersions !== undefined)
				await Bun.write(
					join(root, ".github/workflows/contributor.yml"),
					publicVersions
						.map((value) => `npm install --global bun@${version(value)}`)
						.join("\n"),
				);
			if (privateVersion !== undefined)
				await Bun.write(
					join(root, ".forgejo/workflows/ci.yml"),
					`npm install -g bun@${version(privateVersion)}`,
				);
			const result = Bun.spawnSync(
				[
					process.execPath,
					"--no-env-file",
					"--config=/dev/null",
					"test",
					join(import.meta.dir, "scripts.test.ts"),
					"-t",
					"the pinned Bun passes",
				],
				{ cwd: root, env: cleanEnv(root), timeout: 10_000 },
			);
			const output = result.stdout.toString() + result.stderr.toString();
			expect(output).toContain("Ran 1 test across 1 file");
			if (ok) expect(result.exitCode, output).toBe(0);
			else expect(result.exitCode, output).not.toBe(0);
		},
	);
});

describe("failure lines for CI logs", () => {
	test("keeps the failing test names, their errors, and timeout notes, from the whole output", () => {
		const filler = Array.from({ length: 200 }, (_, i) => `(pass) test ${i}`);
		const text = [
			...filler,
			"test/server/x.test.ts:",
			"\u001b[31merror: expect(received).toBe(expected)\u001b[39m",
			"(fail) fgj read x > reads every page [12.00ms]",
			"(fail) fgj write y > times out [5000.80ms]",
			"  ^ this test timed out after 5000ms.",
			" 200 pass",
		].join("\n");
		expect(failLines(text)).toEqual([
			"error: expect(received).toBe(expected)",
			"(fail) fgj read x > reads every page [12.00ms]",
			"(fail) fgj write y > times out [5000.80ms]",
			"  ^ this test timed out after 5000ms.",
		]);
	});

	test("keeps at most 60 lines", () => {
		const text = Array.from({ length: 100 }, (_, i) => `(fail) t ${i}`).join(
			"\n",
		);
		expect(failLines(text)).toHaveLength(60);
	});
});

describe("install:uat", () => {
	test("installs only for the harnesses that are not current", () => {
		expect(
			pending({
				harnesses: [
					{ harness: "codex", state: "current" },
					{ harness: "claude", state: "outdated" },
					{ harness: "pi", state: "missing" },
				],
			}),
		).toEqual(["claude", "pi"]);
	});
});

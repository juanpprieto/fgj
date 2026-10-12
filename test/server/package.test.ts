import { beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	createIssue,
	createRepo,
	expectOk,
	loadServer,
	onlyGets,
	type TestServer,
} from "../support/forgejo.ts";
import { cleanEnv, tempDir } from "../support/tmp.ts";

const ROOT = join(import.meta.dir, "../..");
let server: TestServer;
let issueUrl: string;
let installed: string;
let home: string;

beforeAll(async () => {
	server = await loadServer();
	const repo = await createRepo(server);
	const number = await createIssue(server, repo, "Package installation smoke");
	issueUrl = `${server.url}/${repo.owner}/${repo.name}/issues/${number}`;
	home = tempDir("fgj-installed-read-");
	let tarball = process.env.FGJ_PACKAGE_TARBALL;
	if (!tarball) {
		const packed = Bun.spawnSync(["bun", "run", "package"], { cwd: ROOT });
		expect(packed.exitCode, packed.stderr.toString()).toBe(0);
		tarball = JSON.parse(
			packed.stdout.toString().trim().split("\n").at(-1) as string,
		).tarball as string;
	}
	const install = Bun.spawnSync(
		[
			"npm",
			"install",
			"--global",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--prefix",
			join(home, "prefix"),
			tarball,
		],
		{
			cwd: home,
			env: {
				...cleanEnv(home),
				TMPDIR: tempDir("fgj-package-child-"),
				npm_config_update_notifier: "false",
				npm_config_cache: join(home, "cache"),
				npm_config_userconfig: join(home, "npmrc"),
				npm_config_globalconfig: join(home, "global-npmrc"),
			},
		},
	);
	expect(install.exitCode, install.stderr.toString()).toBe(0);
	installed = join(home, "prefix/bin/fgj");
}, 120_000);

test("the npm-installed candidate reads one synthetic issue without a checkout or harness changes", async () => {
	const argv = ["read", "issue", "get", issueUrl];
	const traceFile = join(home, "trace.jsonl");
	const startedAt = new Date().toISOString();
	const proc = Bun.spawn([installed, ...argv], {
		cwd: home,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...cleanEnv(home),
			TMPDIR: tempDir("fgj-package-child-"),
			FGJ_URL: server.url,
			FGJ_READ_TOKEN: server.readToken,
			FGJ_TRACE: traceFile,
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	try {
		const result = {
			argv,
			stdout,
			stderr,
			code,
			startedAt,
			trace: readFileSync(traceFile, "utf8"),
		};
		const output = await expectOk<{ title: string; as: string }>(result);
		expect(output).toMatchObject({
			title: "Package installation smoke",
			as: "env",
		});
		expect(onlyGets(result)).toBe(true);
		expect(stdout + stderr + result.trace).not.toContain(server.readToken);
	} finally {
		rmSync(traceFile, { force: true });
	}
}, 30_000);

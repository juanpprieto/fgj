import { beforeAll, describe, expect, test } from "bun:test";
import { chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import {
	addComment,
	createIssue,
	createRepo,
	loadServer,
	makeWorkDir,
	type TestServer,
} from "../support/forgejo.ts";
import { cleanEnv, tempDir } from "../support/tmp.ts";

const ROOT = join(import.meta.dir, "..", "..");

/** Runs the compiled binary, not the source, with the given env. */
async function run(
	bin: string,
	args: string[],
	cwd: string,
	env: Record<string, string>,
) {
	const started = performance.now();
	const proc = Bun.spawn([bin, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...cleanEnv(cwd), ...env },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code, ms: performance.now() - started };
}

describe("the compiled fgj binary", () => {
	let bin: string;
	let version: string;
	let server: TestServer;

	beforeAll(async () => {
		server = await loadServer();
		bin = join(tempDir("fgj-bin-"), "fgj");
		const build = Bun.spawnSync(["bun", "scripts/build.ts", "--outfile", bin], {
			cwd: ROOT,
		});
		expect(build.exitCode).toBe(0);
		version = JSON.parse(build.stdout.toString()).version;
	}, 60_000);

	test("help and --version name the build", async () => {
		expect(version).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{7,}(-dirty)?$/);
		const cwd = tempDir("fgj-bin-");
		const help = await run(bin, ["help"], cwd, {});
		expect(help.code).toBe(0);
		expect(JSON.parse(help.stdout).version).toBe(version);
		const v = await run(bin, ["--version"], cwd, {});
		expect(JSON.parse(v.stdout)).toEqual({ version });
	});

	test("it reads from the real server and redacts a bad token", async () => {
		const repo = await createRepo(server);
		const issue = await createIssue(server, repo, "Binary smoke");
		await addComment(server, repo, issue, "from the binary");
		const cwd = await makeWorkDir(server, repo);
		const env = {
			FGJ_URL: server.url,
			FGJ_READ_TOKEN: server.readToken,
			FGJ_WRITE_TOKEN: server.writeToken,
		};
		const ok = await run(
			bin,
			["read", "comment", "list", String(issue)],
			cwd,
			env,
		);
		expect(ok.stderr).toBe("");
		expect(JSON.parse(ok.stdout)).toMatchObject({ total: 1, as: "env" });

		const bad = "bad0000000000000000";
		const denied = await run(
			bin,
			["read", "comment", "list", String(issue)],
			cwd,
			{
				...env,
				FGJ_READ_TOKEN: bad,
			},
		);
		expect(denied.code).toBe(3);
		expect(denied.stderr).not.toContain(bad);
	});

	test("install:local copies the binary, and refuses a file that is not fgj", async () => {
		const dir = tempDir("fgj-install-");
		const install = () =>
			Bun.spawnSync(["bun", "scripts/install-local.ts", "--dirty"], {
				cwd: ROOT,
				env: { ...process.env, FGJ_INSTALL_DIR: dir },
			});
		const first = install();
		expect(first.exitCode).toBe(0);
		const out = JSON.parse(first.stdout.toString());
		expect(out.installed).toBe(join(dir, "fgj"));
		expect(out.version).toMatch(/^\d+\.\d+\.\d+\+/);
		expect(JSON.parse(install().stdout.toString()).previous).toBe(out.version);

		// Linux refuses to open a binary for writing while it still runs (ETXTBSY),
		// so write the other tool next to it and rename it over the binary.
		await Bun.write(join(dir, "other"), "#!/bin/sh\necho other tool\n");
		await chmod(join(dir, "other"), 0o755);
		await rename(join(dir, "other"), join(dir, "fgj"));
		const other = install();
		expect(other.exitCode).toBe(1);
		expect(other.stderr.toString()).toContain("is not an fgj binary");
	}, 120_000);

	test("the skill text is inside the binary, not read from the repo", async () => {
		const cwd = tempDir("fgj-bin-");
		const r = await run(bin, ["skill", "show"], cwd, {});
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout).content).toBe(
			await Bun.file(join(ROOT, "skill", "fgj", "SKILL.md")).text(),
		);
	});

	test("fgj auth with no terminal fails at once", async () => {
		const cwd = tempDir("fgj-bin-");
		const r = await run(bin, ["auth", server.url], cwd, {});
		expect(r.code).toBe(2);
		// Generous bound: it proves no wait for input (which would hang), not speed.
		expect(r.ms).toBeLessThan(10_000);
	});
});

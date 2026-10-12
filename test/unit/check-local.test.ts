import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanEnv, tempDir } from "../support/tmp.ts";

const SCRIPT = join(import.meta.dir, "../../scripts/check.ts");

function fixture(missing?: string) {
	const root = tempDir("fgj-local-check-");
	const bin = join(root, "bin");
	mkdirSync(bin);
	mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			version: "test",
			devDependencies: { "@types/bun": Bun.version },
		}),
	);
	for (const tool of ["git", "node", "npm", "codex", "pi", "podman"]) {
		if (tool === missing) continue;
		const path = join(bin, tool);
		writeFileSync(path, `#!/bin/sh\nexit ${tool === "podman" ? 1 : 0}\n`);
		chmodSync(path, 0o755);
	}
	for (const tool of ["biome", "tsc"])
		symlinkSync(join(bin, "git"), join(root, "node_modules/.bin", tool));
	const fakeBun = join(bin, "bun");
	writeFileSync(
		fakeBun,
		`#!/bin/sh
printf '%s|%s|%s|%s\\n' "$*" "$FGJ_FORGEJO_PORT" "$CI" "$FGJ_PACKAGE_TARBALL" >> calls
case "$*" in
  'scripts/package.ts') printf '{"tarball":"%s/dist/fgj-test.tgz"}\\n' "$PWD" ;;
  'scripts/forgejo-test-server.ts start') mkdir -p .forgejo-test; printf owned > .forgejo-test/server.json; exit "\${START_CODE:-0}" ;;
  'scripts/forgejo-test-server.ts stop') rm -f .forgejo-test/server.json; exit "\${STOP_CODE:-0}" ;;
  test*) exit "\${TEST_CODE:-0}" ;;
esac
`,
	);
	chmodSync(fakeBun, 0o755);
	const run = (extra: Record<string, string> = {}) =>
		Bun.spawnSync(
			[
				process.execPath,
				"--no-env-file",
				"--config=/dev/null",
				SCRIPT,
				"--local",
			],
			{
				cwd: root,
				env: {
					...cleanEnv(root),
					PATH: `${bin}:/usr/bin:/bin`,
					FGJ_FORGEJO_MODE: "binary",
					...extra,
				},
			},
		);
	const calls = () =>
		existsSync(join(root, "calls"))
			? readFileSync(join(root, "calls"), "utf8")
			: "";
	return { root, run, calls };
}

describe("local contributor check", () => {
	test("checks missing harness tools before provisioning", () => {
		const f = fixture("pi");
		const result = f.run({ PATH: join(f.root, "bin") });
		expect(result.exitCode).toBe(1);
		expect(result.stdout.toString()).toContain("pi");
		expect(f.calls()).toBe("");
	});
	test("refuses existing fixture state without changing it", () => {
		const f = fixture();
		mkdirSync(join(f.root, ".forgejo-test"));
		writeFileSync(
			join(f.root, ".forgejo-test/server.json"),
			"someone else's fixture",
		);
		expect(f.run().exitCode).toBe(1);
		expect(f.calls()).toBe("");
		expect(
			readFileSync(join(f.root, ".forgejo-test/server.json"), "utf8"),
		).toBe("someone else's fixture");
	});
	for (const [name, extra] of [
		["success", {}],
		["test failure", { TEST_CODE: "1" }],
		["startup failure", { START_CODE: "1" }],
	] as const) {
		test(`stops only its fixture after ${name}`, () => {
			const f = fixture();
			const result = f.run(extra);
			expect(result.exitCode).toBe(name === "success" ? 0 : 1);
			expect(existsSync(join(f.root, ".forgejo-test/server.json"))).toBe(false);
			expect(f.calls()).toContain("scripts/forgejo-test-server.ts stop");
			const start = f
				.calls()
				.split("\n")
				.find((line) =>
					line.startsWith("scripts/forgejo-test-server.ts start"),
				);
			expect(start).toBeDefined();
			expect(Number(start?.split("|")[1])).toBeGreaterThan(0);
			expect(Number(start?.split("|")[1])).not.toBe(3917);
			expect(start?.split("|")[2]).toBe("1");
			if (name !== "startup failure") {
				expect(f.calls()).toContain(`${f.root}/dist/fgj-test.tgz`);
			}
		});
	}
	for (const [name, code] of [
		["an existing container", 0],
		["an unavailable Podman service", 125],
	] as const) {
		test(`refuses ${name} before provisioning`, () => {
			const f = fixture();
			writeFileSync(join(f.root, "bin/podman"), `#!/bin/sh\nexit ${code}\n`);
			expect(f.run({ FGJ_FORGEJO_MODE: "podman" }).exitCode).toBe(1);
			expect(f.calls()).toBe("");
		});
	}
	test("refuses missing Podman before provisioning", () => {
		const f = fixture("podman");
		expect(
			f.run({ FGJ_FORGEJO_MODE: "podman", PATH: join(f.root, "bin") }).exitCode,
		).toBe(1);
		expect(f.calls()).toBe("");
	});
	test("a cleanup failure fails the complete check", () => {
		const f = fixture();
		expect(f.run({ STOP_CODE: "1" }).exitCode).toBe(1);
	});
	test("refuses a concurrent check without removing its lock", () => {
		const f = fixture();
		mkdirSync(join(f.root, ".forgejo-test"));
		writeFileSync(
			join(f.root, ".forgejo-test/local-check.lock"),
			"another check",
		);
		expect(f.run().exitCode).toBe(1);
		expect(f.calls()).toBe("");
		expect(
			readFileSync(join(f.root, ".forgejo-test/local-check.lock"), "utf8"),
		).toBe("another check");
	});
	test("refuses an occupied requested port before provisioning", () => {
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		try {
			const f = fixture();
			expect(f.run({ FGJ_FORGEJO_PORT: String(server.port) }).exitCode).toBe(1);
			expect(f.calls()).toBe("");
		} finally {
			server.stop();
		}
	});
});

test("provisioning removes its new container if token creation fails before state is saved", async () => {
	const f = fixture();
	mkdirSync(join(f.root, "scripts"));
	for (const file of ["forgejo-test-server.ts", "forgejo-logs.ts"]) {
		writeFileSync(
			join(f.root, "scripts", file),
			readFileSync(join(import.meta.dir, "../../scripts", file)),
		);
	}
	const podman = join(f.root, "bin/podman");
	writeFileSync(
		podman,
		`#!/bin/sh
case "$1" in
  run) mkdir -p .forgejo-test; : > .forgejo-test/container-owned ;;
  rm) rm -f .forgejo-test/container-owned ;;
esac
`,
	);
	chmodSync(podman, 0o755);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) =>
			new Response("synthetic provisioning failure", {
				status: new URL(request.url).pathname === "/api/v1/version" ? 403 : 500,
			}),
	});
	try {
		const proc = Bun.spawn(
			[process.execPath, "scripts/forgejo-test-server.ts", "start"],
			{
				cwd: f.root,
				env: {
					...cleanEnv(f.root),
					PATH: `${f.root}/bin:/usr/bin:/bin`,
					FGJ_FORGEJO_MODE: "podman",
					FGJ_FORGEJO_PORT: String(server.port),
				},
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		expect(await proc.exited).not.toBe(0);
		expect(existsSync(join(f.root, ".forgejo-test/server.json"))).toBe(false);
		expect(existsSync(join(f.root, ".forgejo-test/container-owned"))).toBe(
			false,
		);
	} finally {
		await server.stop(true);
	}
});

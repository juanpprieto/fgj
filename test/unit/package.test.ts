import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanEnv, tempDir } from "../support/tmp.ts";

const ROOT = join(import.meta.dir, "../..");
const PACKAGE = JSON.parse(
	readFileSync(join(ROOT, "package.json"), "utf8"),
) as {
	version: string;
	repository?: { type: string; url: string };
};
let tarball: string;
let digest: string;
let inventory: string[];

/** Makes valid package inputs with a small builder to isolate each invalid field. */
function packageFixture(): string {
	const home = realpathSync(tempDir("fgj-package-input-"));
	mkdirSync(join(home, "scripts"));
	for (const file of [
		"README.md",
		"scripts/package.ts",
		"package.json",
		"LICENSE-MIT",
		"LICENSE-APACHE",
	])
		writeFileSync(join(home, file), readFileSync(join(ROOT, file)));
	const bundle = `#!/usr/bin/env -S bun --no-env-file --config=/dev/null\nconsole.log(${JSON.stringify(`${PACKAGE.version}+test`)});\n`;
	writeFileSync(
		join(home, "scripts/build.ts"),
		`await Bun.write(process.argv.at(-1), ${JSON.stringify(bundle)});`,
	);
	return home;
}

function run(argv: string[], cwd: string, env = cleanEnv(cwd)) {
	const result = Bun.spawnSync(argv, {
		cwd,
		env: { ...env, TMPDIR: tempDir("fgj-package-child-") },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function ok(argv: string[], cwd: string, env = cleanEnv(cwd)) {
	const result = run(argv, cwd, env);
	expect(result, argv.join(" ")).toMatchObject({ code: 0, stderr: "" });
	return result.stdout;
}

beforeAll(() => {
	if (process.env.FGJ_PACKAGE_TARBALL)
		tarball = process.env.FGJ_PACKAGE_TARBALL;
	else {
		const packed = run(["bun", "run", "package"], ROOT);
		expect(packed.code, packed.stderr).toBe(0);
		tarball = JSON.parse(
			packed.stdout.trim().split("\n").at(-1) as string,
		).tarball;
	}
	digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
	inventory = ok(["tar", "-tzf", tarball], ROOT).trim().split("\n").sort();
	console.log(
		JSON.stringify({
			packageEvidence: true,
			head: ok(["git", "rev-parse", "HEAD"], ROOT).trim(),
			os: process.platform,
			arch: process.arch,
			kernel: ok(["uname", "-sr"], ROOT).trim(),
			bun: ok(["bun", "--version"], ROOT).trim(),
			node: ok(["node", "--version"], ROOT).trim(),
			npm: ok(["npm", "--version"], ROOT).trim(),
			sha256: digest,
			inventory,
		}),
	);
}, 120_000);

afterAll(() => {
	if (tarball)
		expect(
			createHash("sha256").update(readFileSync(tarball)).digest("hex"),
		).toBe(digest);
});

describe("the script-free npm candidate", () => {
	test.each(["README.md", "docs/uat.md", "archive README.md"])(
		"%s distinguishes Git on PATH from a source checkout",
		(path) => {
			let guide: string;
			if (path === "archive README.md") {
				const home = tempDir("fgj-package-guide-");
				ok(["tar", "-xzf", tarball, "-C", home], home);
				guide = readFileSync(join(home, "package/README.md"), "utf8");
			} else guide = readFileSync(join(ROOT, path), "utf8");
			const text = guide.replace(/\s+/g, " ");
			expect(text).toContain("Auth and network commands require Git on PATH.");
			expect(text).toContain("No source checkout is required.");
			expect(text).toContain(
				"Installation, help and version work without Git.",
			);
			expect(text).toContain("The package has no npm runtime dependencies.");
			expect(text).not.toContain("not Git, source files");
		},
	);

	test("the archive has only the executable, manifest, guide and both licenses", () => {
		expect(inventory).toEqual([
			"package/LICENSE-APACHE",
			"package/LICENSE-MIT",
			"package/README.md",
			"package/cli.js",
			"package/package.json",
		]);
		const home = tempDir("fgj-package-inspect-");
		ok(["tar", "-xzf", tarball, "-C", home], home);
		const metadata = JSON.parse(
			readFileSync(join(home, "package/package.json"), "utf8"),
		);
		expect(metadata).toEqual({
			name: "fgj",
			version: PACKAGE.version,
			description: "Forgejo command-line interface for LLM agents",
			license: "MIT OR Apache-2.0",
			type: "module",
			bin: { fgj: "cli.js" },
			engines: { bun: "1.3.14" },
			os: ["darwin", "linux"],
			cpu: ["arm64"],
			...(PACKAGE.repository ? { repository: PACKAGE.repository } : {}),
		});
		expect(
			readFileSync(join(home, "package/cli.js"), "utf8").split("\n")[0],
		).toBe("#!/usr/bin/env -S bun --no-env-file --config=/dev/null");
		for (const license of ["LICENSE-MIT", "LICENSE-APACHE"])
			expect(readFileSync(join(home, "package", license), "utf8")).toBe(
				readFileSync(join(ROOT, license), "utf8"),
			);
	});

	for (const route of ["npm", "npx", "bun"])
		for (const scripts of [true, false]) {
			test(`${route}, lifecycle scripts ${scripts ? "enabled" : "disabled"}, isolates startup and callback replay`, () => {
				const home = tempDir("fgj-package space-");
				const cwd = join(home, "not a git checkout");
				mkdirSync(cwd);
				const sentinel = join(home, "sentinel");
				mkdirSync(sentinel);
				const sentinelContent = (name: string) =>
					name === "settings.json"
						? '{"permissions":{"allow":["Bash(echo safe)"]}}\n'
						: "unchanged\n";
				for (const name of ["fgj", "settings.json", "fgj.rules", "fgj-gate.ts"])
					writeFileSync(join(sentinel, name), sentinelContent(name));
				const env = {
					...cleanEnv(home),
					CODEX_HOME: sentinel,
					CLAUDE_CONFIG_DIR: sentinel,
					PI_CODING_AGENT_DIR: sentinel,
					npm_config_update_notifier: "false",
					npm_config_cache: join(home, "npm-cache"),
					npm_config_userconfig: join(home, "npmrc"),
					npm_config_globalconfig: join(home, "global-npmrc"),
					BUN_INSTALL: join(home, "bun-install"),
					BUN_INSTALL_CACHE_DIR: join(home, "bun-cache"),
					XDG_CONFIG_HOME: join(home, "config"),
					XDG_STATE_HOME: join(home, "state"),
				};
				let command: string[];
				if (route === "npm") {
					const installed = run(
						[
							"npm",
							"install",
							"--global",
							"--prefix",
							join(home, "npm-prefix"),
							"--no-audit",
							"--no-fund",
							...(scripts ? [] : ["--ignore-scripts"]),
							tarball,
						],
						cwd,
						env,
					);
					expect(installed.code, installed.stderr).toBe(0);
					command = [join(home, "npm-prefix/bin/fgj")];
				} else if (route === "npx")
					command = [
						"npx",
						"--yes",
						...(scripts ? [] : ["--ignore-scripts"]),
						"--package",
						tarball,
						"fgj",
					];
				else {
					const installed = run(
						[
							"bun",
							"add",
							"--global",
							...(scripts ? [] : ["--ignore-scripts"]),
							tarball,
						],
						cwd,
						env,
					);
					expect(installed.code, installed.stderr).toBe(0);
					command = [join(home, "bun-install/bin/fgj")];
				}
				// These files are adversarial fixtures, never the developer's settings.
				writeFileSync(join(cwd, ".env"), "FGJ_PROFILE=hostile\n");
				writeFileSync(
					join(cwd, "preload.ts"),
					'throw new Error("hostile preload ran");\n',
				);
				writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
				writeFileSync(
					join(home, ".bunfig.toml"),
					`preload = [${JSON.stringify(join(cwd, "preload.ts"))}]\n`,
				);
				const status = JSON.parse(ok([...command, "auth", "status"], cwd, env));
				expect(status.profiles).toEqual([]);
				expect(status.active.error).toStartWith("No host:");
				const version = JSON.parse(
					ok([...command, "version"], cwd, env),
				).version;
				expect(version).toStartWith(`${PACKAGE.version}+`);
				expect(version.slice(PACKAGE.version.length)).toMatch(
					/^\+[a-f0-9]{7,}(-dirty)?$/,
				);
				expect(JSON.parse(ok([...command, "help"], cwd, env)).version).toBe(
					version,
				);
				for (const harness of ["codex", "claude", "pi"]) {
					const generated = JSON.parse(
						ok([...command, "rules", "show", harness], cwd, env),
					);
					expect(generated.content).toContain("fgj");
					if (harness === "pi") {
						const callback = JSON.parse(
							/^const FGJ: string\[\] = (.+);$/m.exec(generated.content)?.[1] ??
								"null",
						) as string[];
						expect(callback.slice(1, 3)).toEqual([
							"--no-env-file",
							"--config=/dev/null",
						]);
						expect(callback.at(-1)).toContain("cli.js");
						expect(
							JSON.parse(ok([...callback, "version"], cwd, env)).version,
						).toBe(version);
						expect(
							JSON.parse(ok([...callback, "auth", "status"], cwd, env)).active
								.error,
						).toStartWith("No host:");
					}
				}
				expect(
					JSON.parse(ok([...command, "skill", "show"], cwd, env)).content,
				).toBe(readFileSync(join(ROOT, "skill/fgj/SKILL.md"), "utf8"));
				for (const name of ["fgj", "settings.json", "fgj.rules", "fgj-gate.ts"])
					expect(readFileSync(join(sentinel, name), "utf8")).toBe(
						sentinelContent(name),
					);
				expect(
					createHash("sha256").update(readFileSync(tarball)).digest("hex"),
				).toBe(digest);
				console.log(
					JSON.stringify({
						route,
						scripts,
						version,
						sha256: digest,
						os: process.platform,
						arch: process.arch,
					}),
				);
			}, 120_000);
		}

	test("absent Bun fails without running the CLI", () => {
		const home = tempDir("fgj-package-no-bun-");
		ok(["tar", "-xzf", tarball, "-C", home], home);
		const result = run([join(home, "package/cli.js"), "help"], home, {
			...cleanEnv(home),
			PATH: home,
		});
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("bun");
	});

	for (const name of ["bun.exe", "alternate-runtime"])
		test(`a runtime named ${name} retains the installed script and isolation flags`, () => {
			const home = realpathSync(tempDir("fgj-package-runtime-"));
			ok(["tar", "-xzf", tarball, "-C", home], home);
			const runtime = join(home, name);
			// A copy changes process.execPath; a symlink can resolve to the original name.
			writeFileSync(runtime, readFileSync(process.execPath));
			chmodSync(runtime, 0o755);
			const output = JSON.parse(
				ok(
					[
						runtime,
						"--no-env-file",
						"--config=/dev/null",
						join(home, "package/cli.js"),
						"rules",
						"show",
						"pi",
					],
					home,
				),
			);
			const callback = JSON.parse(
				/^const FGJ: string\[\] = (.+);$/m.exec(output.content)?.[1] ?? "null",
			) as string[];
			expect(callback).toEqual([
				runtime,
				"--no-env-file",
				"--config=/dev/null",
				join(home, "package/cli.js"),
			]);
			const version = JSON.parse(ok([...callback, "version"], home)).version;
			expect(version).toStartWith(`${PACKAGE.version}+`);
			expect(version.slice(PACKAGE.version.length)).toMatch(
				/^\+[a-f0-9]{7,}(-dirty)?$/,
			);
		});

	test("the native build callback uses only the standalone executable", () => {
		const home = realpathSync(tempDir("fgj-package-native-"));
		const binary = join(home, "fgj");
		const built = JSON.parse(
			ok(["bun", "scripts/build.ts", "--outfile", binary], ROOT),
		);
		writeFileSync(join(home, "bunfig.toml"), 'preload = ["./hostile.ts"]\n');
		writeFileSync(
			join(home, "hostile.ts"),
			'throw new Error("native preload ran");',
		);
		writeFileSync(join(home, ".env"), "FGJ_PROFILE=hostile\n");
		const output = JSON.parse(ok([binary, "rules", "show", "pi"], home));
		const callback = JSON.parse(
			/^const FGJ: string\[\] = (.+);$/m.exec(output.content)?.[1] ?? "null",
		) as string[];
		expect(callback).toEqual([binary]);
		expect(JSON.parse(ok([...callback, "version"], home)).version).toBe(
			built.version,
		);
		expect(
			JSON.parse(ok([...callback, "auth", "status"], home)).active.error,
		).toStartWith("No host:");
	}, 60_000);
});

describe("package inputs fail closed", () => {
	test.each(["0.1.0", "0.1.0-rc.1"])(
		"packs and installs version %s with its public repository metadata",
		(version) => {
			const home = packageFixture();
			const metadata = JSON.parse(
				readFileSync(join(home, "package.json"), "utf8"),
			);
			const repository = {
				type: "git",
				url: "git+https://github.com/example/fgj.git",
			};
			writeFileSync(
				join(home, "package.json"),
				JSON.stringify({ ...metadata, version, repository }),
			);
			const bundle = `#!/usr/bin/env -S bun --no-env-file --config=/dev/null\nconsole.log(JSON.stringify({version: "${version}+test"}));\n`;
			writeFileSync(
				join(home, "scripts/build.ts"),
				`await Bun.write(process.argv.at(-1), ${JSON.stringify(bundle)});`,
			);
			const packed = run(["bun", join(home, "scripts/package.ts")], home);
			expect(packed.code, packed.stderr).toBe(0);
			const archive = JSON.parse(packed.stdout).tarball;
			expect(archive).toBe(join(home, "dist", `fgj-${version}.tgz`));
			ok(["tar", "-xzf", archive, "-C", home], home);
			expect(
				JSON.parse(readFileSync(join(home, "package/package.json"), "utf8")),
			).toMatchObject({ version, repository });
			const guide = readFileSync(join(home, "package/README.md"), "utf8");
			expect(guide).toContain(
				`bun add --global --ignore-scripts "$PWD/fgj-${version}.tgz"`,
			);
			if (version !== "0.1.0") expect(guide).not.toContain("fgj-0.1.0.tgz");
			const installed = run(
				[
					"npm",
					"install",
					"--global",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					"--prefix",
					join(home, "prefix"),
					archive,
				],
				home,
				{
					...cleanEnv(home),
					npm_config_cache: join(home, "cache"),
					npm_config_userconfig: join(home, "npmrc"),
					npm_config_globalconfig: join(home, "global-npmrc"),
				},
			);
			expect(installed.code, installed.stderr).toBe(0);
			expect(
				JSON.parse(ok([join(home, "prefix/bin/fgj"), "version"], home)),
			).toEqual({ version: `${version}+test` });
		},
		30_000,
	);

	test.each([
		null,
		"git+https://github.com/example/fgj.git",
		{ type: "git", url: "https://example.invalid/fgj.git" },
		{
			type: "git",
			url: "git+https://github.com/example/fgj.git?token=fixture",
		},
		{ type: "git", url: "git+https://github.com/example/fgj.git\n" },
		{
			type: "git",
			url: "git+https://github.com/example/fgj.git",
			secret: "fixture",
		},
	])("rejects unsafe repository metadata %j", (repository) => {
		const home = packageFixture();
		const metadata = JSON.parse(
			readFileSync(join(home, "package.json"), "utf8"),
		);
		writeFileSync(
			join(home, "package.json"),
			JSON.stringify({ ...metadata, repository }),
		);
		const result = run(["bun", join(home, "scripts/package.ts")], home);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("repository metadata");
		expect(existsSync(join(home, "dist/fgj-0.1.0.tgz"))).toBe(false);
	});

	test("packing does not leave an npm cache in the caller's home or cache", () => {
		const home = packageFixture();
		const ambientCache = join(home, "ambient-cache");
		const result = run(["bun", join(home, "scripts/package.ts")], home, {
			...cleanEnv(home),
			npm_config_cache: ambientCache,
		});
		expect(result.code, result.stderr).toBe(0);
		expect(existsSync(ambientCache)).toBe(false);
		expect(existsSync(join(home, ".npm"))).toBe(false);
	});
	for (const args of [
		["--bundle", "--target", "bun-linux-x64"],
		["--outfile"],
		["--outfile", ""],
		["--target"],
		["--target", ""],
	])
		test(`rejects invalid build arguments ${JSON.stringify(args)}`, () => {
			const home = tempDir("fgj-build-arguments-");
			mkdirSync(join(home, "scripts"));
			writeFileSync(
				join(home, "scripts/build.ts"),
				readFileSync(join(ROOT, "scripts/build.ts")),
			);
			const result = run(
				["bun", join(home, "scripts/build.ts"), ...args],
				home,
			);
			expect(result.code).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Build arguments:");
		});
	for (const value of [
		undefined,
		"",
		"{",
		"null",
		"[]",
		"{}",
		'{"name":"","version":"0.1.0","license":"MIT OR Apache-2.0"}',
		'{"name":"fgj","license":"MIT OR Apache-2.0"}',
		'{"name":"fgj","version":"0.1.0"}',
		'{"name":"fgj"}',
		'{"name":"fgj","version":null}',
		'{"name":"fgj","version":""}',
		'{"name":"other","version":"0.1.0"}',
		'{"name":7,"version":"0.1.0","license":"MIT OR Apache-2.0"}',
		'{"name":"fgj","version":"0.1.0","license":null}',
		'{"name":"fgj","version":"0.1.0","license":""}',
	]) {
		test(`rejects metadata ${JSON.stringify(value)}`, () => {
			const home = packageFixture();
			if (value === undefined) rmSync(join(home, "package.json"));
			else writeFileSync(join(home, "package.json"), value);
			const result = run(["bun", join(home, "scripts/package.ts")], home);
			expect(result.code).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).not.toBe("");
			if (value !== undefined && value !== "" && value !== "{")
				expect(result.stderr).toContain(
					"Expected fgj metadata with a valid version and both licenses.",
				);
			expect(Bun.file(join(home, "dist/fgj-0.1.0.tgz")).size).toBe(0);
		});
	}
	for (const output of [
		"",
		"{",
		"null",
		"[]",
		'[{"filename":"fgj-0.1.0.tgz","files":null}]',
		'[{"filename":"fgj-0.1.0.tgz","files":[]}]',
		'[{"files":[]}]',
		'[{"filename":7,"files":[]}]',
		'[{"filename":"","files":[]}]',
		'[{"filename":"fgj-0.1.0.tgz","files":[{}]}]',
		'[{"filename":"fgj-0.1.0.tgz","files":[{"path":7}]}]',
		'[{"filename":"fgj-0.1.0.tgz","files":[{"path":""}]}]',
	])
		test(`corrupt npm pack output ${JSON.stringify(output)} writes no final archive`, () => {
			const home = packageFixture();
			const bin = join(home, "bin");
			mkdirSync(bin);
			writeFileSync(
				join(bin, "npm"),
				`#!/usr/bin/env bun\nimport {join} from "node:path";\nawait Bun.write(join(process.argv[process.argv.indexOf("--pack-destination") + 1], "fgj-0.1.0.tgz"), "unreviewed");\nconsole.log(${JSON.stringify(output)});\n`,
			);
			chmodSync(join(bin, "npm"), 0o755);
			const result = run(["bun", join(home, "scripts/package.ts")], home, {
				...cleanEnv(home),
				PATH: `${bin}:${process.env.PATH}`,
			});
			expect(result.code).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(existsSync(join(home, "dist/fgj-0.1.0.tgz"))).toBe(false);
		});

	for (const license of ["LICENSE-MIT", "LICENSE-APACHE"])
		for (const value of [undefined, "", "corrupt", 7])
			test(`rejects license ${license} ${JSON.stringify(value)}`, () => {
				const home = packageFixture();
				if (value === undefined) rmSync(join(home, license));
				else writeFileSync(join(home, license), String(value));
				const result = run(["bun", join(home, "scripts/package.ts")], home);
				expect(result.code).not.toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain(license);
				expect(existsSync(join(home, "dist/fgj-0.1.0.tgz"))).toBe(false);
			});

	for (const bundle of [undefined, "", "not a bundle"])
		test(`rejects absent or corrupt bundle ${JSON.stringify(bundle)}`, () => {
			const home = packageFixture();
			writeFileSync(
				join(home, "scripts/build.ts"),
				bundle === undefined
					? ""
					: `await Bun.write(process.argv.at(-1), ${JSON.stringify(bundle)});`,
			);
			const result = run(["bun", join(home, "scripts/package.ts")], home);
			expect(result.code).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(
				bundle === undefined
					? "cli.js"
					: "candidate bundle is absent or invalid",
			);
			expect(Bun.file(join(home, "dist/fgj-0.1.0.tgz")).size).toBe(0);
		});
	test("the packed guide reuses the tested user setup from the source README", () => {
		const source = readFileSync(join(ROOT, "README.md"), "utf8")
			.split("<!-- getting-started:start -->")[1]
			?.split("<!-- getting-started:end -->")[0]
			?.trim();
		expect(source).toBeDefined();
		const home = tempDir("fgj-packed-guide-");
		ok(["tar", "-xzf", tarball, "-C", home], home);
		const guide = readFileSync(join(home, "package/README.md"), "utf8");
		expect(guide).toContain(source as string);
		expect(guide).not.toContain("bun run install:local");
	});
});

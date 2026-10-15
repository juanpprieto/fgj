import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { nativeTarget } from "../../scripts/package-native.ts";
import { cleanEnv, tempDir } from "../support/tmp.ts";

const ROOT = resolve(import.meta.dir, "../..");
const MEMBERS = [
	"BUN-LICENSE.md",
	"LICENSE-APACHE",
	"LICENSE-MIT",
	"README.md",
	"fgj",
];

function run(argv: string[], cwd: string, env = cleanEnv(cwd)) {
	const result = Bun.spawnSync(argv, {
		cwd,
		env,
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

function commit(root: string) {
	ok(["git", "add", "."], root);
	ok(
		["git", "commit", "--quiet", "-m", "Record synthetic native inputs"],
		root,
	);
}

function fixture(): string {
	const root = realpathSync(tempDir("fgj-native-input-"));
	mkdirSync(join(root, "scripts"));
	mkdirSync(join(root, "docs"));
	for (const directory of ["src", "skill"])
		cpSync(join(ROOT, directory), join(root, directory), { recursive: true });
	for (const path of [
		".gitignore",
		"package.json",
		"scripts/build.ts",
		"scripts/package-native.ts",
		"docs/bun-license.md",
		"docs/native.md",
		"LICENSE-MIT",
		"LICENSE-APACHE",
	])
		writeFileSync(join(root, path), readFileSync(join(ROOT, path)));
	ok(["git", "init", "--quiet", "--initial-branch=main"], root);
	ok(["git", "config", "user.name", "Native package fixture"], root);
	ok(["git", "config", "user.email", "fixture@example.invalid"], root);
	commit(root);
	return root;
}

let root: string;
let candidate: {
	tarball: string;
	sha256: string;
	binary_sha256: string;
	source_sha: string;
	version: string;
	package_version: string;
	inventory: string[];
	local_only: boolean;
	apple_notarization: boolean;
};

beforeAll(() => {
	root = fixture();
	candidate = JSON.parse(
		ok([process.execPath, "scripts/package-native.ts"], root),
	);
}, 120_000);

test.each([
	["darwin", "arm64", "macos-arm64", "bun-darwin-arm64"],
	["linux", "arm64", "linux-arm64", "bun-linux-arm64"],
])("%s %s selects only its native target", (platform, arch, name, target) => {
	expect(nativeTarget(platform, arch)).toEqual({ name, target });
});

test.each([
	["darwin", "x64"],
	["linux", "x64"],
	["win32", "arm64"],
	["freebsd", "arm64"],
])(
	"%s %s fails with an explicit unsupported-platform error",
	(platform, arch) => {
		expect(() => nativeTarget(platform, arch)).toThrow(
			"Native packaging supports macOS arm64 and Linux arm64 only.",
		);
	},
);

test("the local archive binds the executable, licenses and guide to its clean source", () => {
	const head = ok(["git", "rev-parse", "HEAD"], root).trim();
	const short = ok(["git", "rev-parse", "--short", "HEAD"], root).trim();
	const target = nativeTarget(process.platform, process.arch);
	expect(candidate).toMatchObject({
		source_sha: head,
		version: `${candidate.package_version}+${short}`,
		inventory: MEMBERS,
		local_only: true,
		apple_notarization: false,
	});
	expect(candidate.tarball).toBe(
		join(
			root,
			"dist/native",
			`fgj-${candidate.package_version}-${target.name}.tar.gz`,
		),
	);
	const archiveBytes = readFileSync(candidate.tarball);
	expect(createHash("sha256").update(archiveBytes).digest("hex")).toBe(
		candidate.sha256,
	);
	expect(readFileSync(`${candidate.tarball}.sha256`, "utf8")).toBe(
		`${candidate.sha256}  fgj-${candidate.package_version}-${target.name}.tar.gz\n`,
	);
	expect(
		ok(["tar", "-tzf", candidate.tarball], root).trim().split("\n").sort(),
	).toEqual(MEMBERS);
	const extracted = tempDir("fgj-native-extracted-");
	ok(["tar", "-xzf", candidate.tarball, "-C", extracted], root);
	for (const license of ["LICENSE-MIT", "LICENSE-APACHE"])
		expect(readFileSync(join(extracted, license), "utf8")).toBe(
			readFileSync(join(ROOT, license), "utf8"),
		);
	expect(readFileSync(join(extracted, "BUN-LICENSE.md"), "utf8")).toBe(
		readFileSync(join(ROOT, "docs/bun-license.md"), "utf8"),
	);
	const guide = readFileSync(join(extracted, "README.md"), "utf8");
	expect(guide).toContain(`/blob/${head}/docs/release.md`);
	expect(guide).toContain("](BUN-LICENSE.md)");
	expect(guide).not.toContain("fgj-VERSION");
	expect(
		createHash("sha256")
			.update(readFileSync(join(extracted, "fgj")))
			.digest("hex"),
	).toBe(candidate.binary_sha256);
	expect(statSync(join(extracted, "fgj")).mode & 0o100).toBe(0o100);
	const emptyPath = tempDir("fgj-native-empty-path-");
	const env = { ...cleanEnv(extracted), PATH: emptyPath };
	expect(
		JSON.parse(ok([join(extracted, "fgj"), "version"], extracted, env)),
	).toEqual({ version: candidate.version });
	expect(
		JSON.parse(ok([join(extracted, "fgj"), "help"], extracted, env)).version,
	).toBe(candidate.version);
	expect(ok(["git", "status", "--porcelain"], root)).toBe("");
	expect(readdirSync(join(root, "dist/native")).sort()).toEqual([
		`fgj-${candidate.package_version}-${target.name}.tar.gz`,
		`fgj-${candidate.package_version}-${target.name}.tar.gz.sha256`,
	]);
});

test("an existing candidate remains unchanged after a refused replacement", () => {
	const checksum = readFileSync(`${candidate.tarball}.sha256`, "utf8");
	const result = run([process.execPath, "scripts/package-native.ts"], root);
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("A native candidate already exists.");
	expect(
		createHash("sha256").update(readFileSync(candidate.tarball)).digest("hex"),
	).toBe(candidate.sha256);
	expect(readFileSync(`${candidate.tarball}.sha256`, "utf8")).toBe(checksum);
});

test.each(["normal", "hidden"])(
	"an untracked source change fails before creating output when Git visibility is %s",
	(visibility) => {
		const home = fixture();
		if (visibility === "hidden")
			ok(["git", "config", "status.showUntrackedFiles", "no"], home);
		writeFileSync(join(home, "unexpected.txt"), "unreviewed source");
		const result = run([process.execPath, "scripts/package-native.ts"], home);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"Native packaging requires a clean Git checkout.",
		);
		expect(existsSync(join(home, "dist"))).toBe(false);
	},
);

test.each(["--release", "--target", "--publish", "--outfile"])(
	"the local-only packer refuses %s",
	(flag) => {
		const home = fixture();
		const result = run(
			[process.execPath, "scripts/package-native.ts", flag],
			home,
		);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"Native candidate packaging accepts no arguments.",
		);
		expect(existsSync(join(home, "dist"))).toBe(false);
	},
);

test.each([
	["name", "another-tool"],
	["version", "../outside"],
	["license", "MIT"],
])("invalid %s fails before writing an archive", (key, value) => {
	const home = fixture();
	const pkg = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));
	pkg[key] = value;
	writeFileSync(join(home, "package.json"), JSON.stringify(pkg));
	commit(home);
	const result = run([process.execPath, "scripts/package-native.ts"], home);
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("Expected fgj metadata");
	expect(existsSync(join(home, "dist"))).toBe(false);
});

test.each([
	["LICENSE-MIT", "Permission is hereby granted, free of charge"],
	["LICENSE-APACHE", "Version 2.0, January 2004"],
	["docs/bun-license.md", "bun-v1.3.14/LICENSE.md"],
])(
	"truncated %s fails before writing an archive",
	(path, content) => {
		const home = fixture();
		writeFileSync(join(home, path), content);
		commit(home);
		const result = run([process.execPath, "scripts/package-native.ts"], home);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Native packaging requires both licenses");
		expect(existsSync(join(home, "dist"))).toBe(false);
	},
	30_000,
);

test("a build failure removes its owned staging directory", () => {
	const home = fixture();
	writeFileSync(
		join(home, "scripts/build.ts"),
		'throw new Error("Synthetic native build failure");\n',
	);
	commit(home);
	const result = run([process.execPath, "scripts/package-native.ts"], home);
	expect(result.code).toBe(1);
	expect(result.stderr).toContain("Synthetic native build failure");
	expect(readdirSync(join(home, "dist/native"))).toEqual([]);
});

test("prerelease metadata stays in the native archive name and executable", () => {
	const home = fixture();
	const pkg = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));
	pkg.version = "0.1.0-rc.1";
	writeFileSync(join(home, "package.json"), JSON.stringify(pkg));
	commit(home);
	const result = JSON.parse(
		ok([process.execPath, "scripts/package-native.ts"], home),
	);
	expect(result.package_version).toBe("0.1.0-rc.1");
	expect(result.version).toMatch(/^0\.1\.0-rc\.1\+[a-f0-9]{7,}$/);
	expect(result.tarball).toContain("fgj-0.1.0-rc.1-");
}, 120_000);

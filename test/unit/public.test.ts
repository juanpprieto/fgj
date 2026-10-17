import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cleanEnv, tempDir } from "../support/tmp.ts";

const ROOT = join(import.meta.dir, "../..");
const PACKAGE_VERSION = JSON.parse(
	readFileSync(join(ROOT, "package.json"), "utf8"),
).version as string;
const CANARY_PARTS = ["synthetic", "private", "canary"];
const CANARY = CANARY_PARTS.join("-");
const sha256 = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

// These checks catch test markers and common credential forms, not all private data.
// A reviewer must still read every exported path before transfer.
function checkContent(text: string): void {
	const normalized = text
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.replace(/[_.]/g, "-");
	expect(normalized).not.toContain(CANARY);
}

function command(cwd: string, argv: string[]): string {
	const home = tempDir("fgj-public-home-");
	const result = Bun.spawnSync(argv, {
		cwd,
		env: {
			...cleanEnv(home),
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		},
	});
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	return result.stdout.toString();
}

function reviewedTarball(): string {
	return (
		process.env.FGJ_PACKAGE_TARBALL ??
		JSON.parse(
			command(ROOT, ["bun", "run", "package"])
				.trim()
				.split("\n")
				.at(-1) as string,
		).tarball
	);
}

function reviewReason(path: string): string {
	if (path.startsWith("LICENSE-"))
		return "Retain original license text and required attribution.";
	if (path.startsWith("test/fixtures/"))
		return "Retain synthetic Actions parsing cases without private recordings.";
	if (path.startsWith("test/"))
		return "Retain isolated regression tests and synthetic identities.";
	if (path.startsWith("src/"))
		return "Retain generic Forgejo capabilities and public command contracts.";
	if (path.startsWith("assets/"))
		return "Retain CLI branding and public artwork guidance.";
	if (path.endsWith(".md"))
		return "Retain contributor guidance and generic design or research context.";
	return "Retain reproducible build, dependency, hook and CI configuration.";
}

function inventoryRow(path: string, bytes: Buffer) {
	return {
		path,
		sha256: sha256(bytes),
		disposition: "retain",
		reason: reviewReason(path),
	};
}

// Validate the review ledger before accepting any export. This function writes nothing.
function checkInventory(input: unknown, files: Map<string, Buffer>): void {
	if (!Array.isArray(input) || input.length === 0)
		throw new Error("missing inventory");
	const seen = new Set<string>();
	for (const row of input) {
		if (
			!row ||
			typeof row !== "object" ||
			typeof row.path !== "string" ||
			!row.path ||
			typeof row.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(row.sha256) ||
			row.disposition !== "retain" ||
			typeof row.reason !== "string" ||
			!row.reason.trim() ||
			row.reason.includes("\0")
		)
			throw new Error("invalid review row");
		if (seen.has(row.path)) throw new Error("duplicate path");
		const bytes = files.get(row.path);
		if (!bytes || sha256(bytes) !== row.sha256)
			throw new Error("unreviewed path or changed bytes");
		seen.add(row.path);
	}
	if (seen.size !== files.size) throw new Error("inventory gap");
}

function checkPaths(paths: string[]): void {
	for (const path of paths) {
		if (
			path.startsWith("/") ||
			path
				.split("/")
				.some((part) =>
					[
						"",
						".",
						"..",
						".git",
						".pi",
						".claude",
						".codex",
						"node_modules",
						"dist",
						".forgejo-test",
					].includes(part),
				) ||
			/(^|\/)\.env(?:\.|$)|\.(?:map|tgz|tar)$/.test(path)
		)
			throw new Error("unexpected export path");
	}
}

function snapshotFiles(root: string, paths: string[]): Map<string, Buffer> {
	checkPaths(paths);
	return new Map(
		paths.map((path) => {
			if (!lstatSync(join(root, path)).isFile())
				throw new Error("unexpected file type");
			return [path, readFileSync(join(root, path))];
		}),
	);
}

describe("public repository", () => {
	test("security reporting requires a confirmed private channel", () => {
		const guidance = readFileSync(join(ROOT, "SECURITY.md"), "utf8");
		expect(guidance).toContain("Report a vulnerability");
		expect(guidance).toContain("If that option is absent");
		expect(guidance).toContain(
			"Do not send vulnerability details in a public thread",
		);
	});

	test("action policy guidance names exactly the four pinned references", () => {
		const guidance = readFileSync(
			join(ROOT, "docs/github-validation.md"),
			"utf8",
		);
		const patterns = guidance
			.match(
				/The workflow action allowlist is:\n\n```text\n([\s\S]+?)\n```/,
			)?.[1]
			?.split("\n");
		expect(patterns).toEqual([
			"actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
			"actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
			"actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
			"actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
		]);
	});

	test("literal README npm, npx and Bun installation routes use the reviewed archive and reject invalid tarballs", () => {
		const readme = readFileSync(join(ROOT, "docs/setup.md"), "utf8");
		const blocks = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].map(
			(match) => match[1] as string,
		);
		const npmBlock = blocks.find((block) => block.startsWith("npm install"));
		const bunBlock = blocks.find((block) => block.startsWith("BUN_INSTALL="));
		expect(npmBlock).toBeDefined();
		expect(bunBlock).toBeDefined();
		const tarball = reviewedTarball();
		const before = sha256(readFileSync(tarball));
		for (const [route, script, binary] of [
			[
				"npm",
				npmBlock?.split("\n").slice(0, 3).join("\n"),
				"candidate/bin/fgj",
			],
			[
				"npx",
				npmBlock
					?.split("\n")
					.filter((line) => line.startsWith("npx "))
					.join("\n"),
				undefined,
			],
			["Bun", bunBlock, "candidate-bun/bin/fgj"],
		] as const) {
			expect(script?.trim().length, route).toBeGreaterThan(0);
			for (const input of [
				"valid",
				"missing",
				"empty",
				"corrupt",
				"directory",
			]) {
				const root = join(
					tempDir("fgj-public-install-"),
					"directory with spaces",
				);
				mkdirSync(root);
				const archive = join(root, "fgj-0.1.0.tgz");
				if (input === "valid") copyFileSync(tarball, archive);
				if (input === "empty") writeFileSync(archive, "");
				if (input === "corrupt") writeFileSync(archive, "not a tarball");
				if (input === "directory") mkdirSync(archive);
				const result = Bun.spawnSync(["/bin/sh", "-ec", script as string], {
					cwd: root,
					env: {
						...cleanEnv(root),
						TMPDIR: root,
						NPM_CONFIG_CACHE: join(root, "npm-cache"),
						NPM_CONFIG_OFFLINE: "true",
						NPM_CONFIG_UPDATE_NOTIFIER: "false",
					},
				});
				const context = `${route}/${input}: ${result.stderr.toString()}`;
				if (input === "valid") {
					expect(result.exitCode, context).toBe(0);
					const output = result.stdout
						.toString()
						.split("\n")
						.filter((line) => line.startsWith("{"))
						.map((line) => JSON.parse(line));
					expect(output, context).toHaveLength(2);
					expect(output[0].verbs, context).toBeDefined();
					expect(output[0].version, context).toStartWith(`${PACKAGE_VERSION}+`);
					expect(
						output[0].version.slice(PACKAGE_VERSION.length),
						context,
					).toMatch(/^\+[a-f0-9]{7,}(-dirty)?$/);
					expect(output[1], context).toEqual({ version: output[0].version });
				} else {
					expect(result.exitCode, context).not.toBe(0);
					if (binary)
						expect(existsSync(join(root, binary)), context).toBe(false);
				}
			}
		}
		expect(sha256(readFileSync(tarball))).toBe(before);
	}, 120_000);

	test("the contributor guide uses the guarded local check instead of a manual provisioning script", () => {
		const guide = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");
		expect(guide).toContain("bun run check:local");
		expect(guide).not.toContain("export FGJ_FORGEJO_PORT=");
		expect(guide).not.toContain("trap '");
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		expect(pkg.scripts["check:local"]).toBe("bun scripts/check.ts --local");
	});

	test("shared source uses neutral examples outside public identity metadata and links", () => {
		const metadata = JSON.parse(
			readFileSync(join(ROOT, "package.json"), "utf8"),
		);
		const repository = new URL(metadata.repository.url.replace(/^git\+/, ""));
		const slug = repository.pathname.slice(1).replace(/\.git$/, "");
		const owner = slug.split("/")[0] as string;
		const markers = [slug, owner];
		const paths = command(ROOT, ["git", "ls-files", "-z"])
			.split("\0")
			.filter(
				(path) =>
					path &&
					path !== "package.json" &&
					path !== "docs/public-checkout.md" &&
					!path.startsWith(".forgejo/"),
			);
		for (const [path, bytes] of snapshotFiles(ROOT, paths)) {
			if (bytes.includes(0)) continue;
			const text = path.endsWith(".md")
				? bytes
						.toString()
						.replaceAll(`https://github.com/${slug}/`, "PUBLIC_REPOSITORY/")
						.replaceAll(
							`https://github.com/${slug}.git`,
							"PUBLIC_REPOSITORY.git",
						)
				: bytes.toString();
			for (const marker of markers) expect(text, path).not.toContain(marker);
		}
		expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain(
			"synthetic test issue",
		);
	});

	test("inventory rejects missing, empty, wrong-type, corrupt, duplicate and incomplete review data without writes", () => {
		const files = new Map([["README.md", Buffer.from("public")]]);
		const row = inventoryRow("README.md", files.get("README.md") as Buffer);
		checkInventory([row], files);
		for (const key of ["path", "sha256", "disposition", "reason"]) {
			for (const value of [undefined, "", 3, {}, "\0"])
				expect(() =>
					checkInventory([{ ...row, [key]: value }], files),
				).toThrow();
		}
		for (const bad of [
			undefined,
			"corrupt JSON",
			{},
			[],
			[undefined],
			[{ ...row, sha256: "corrupt" }],
			[{ ...row, sha256: "0".repeat(64) }],
			[row, row],
			[{ ...row, path: "unexpected.ts" }],
		])
			expect(() => checkInventory(bad, files)).toThrow();
		expect(() =>
			checkInventory(
				[row],
				new Map([...files, ["new.ts", Buffer.from("new")]]),
			),
		).toThrow("gap");
		expect(files.get("README.md")?.toString()).toBe("public");
	});

	test("export rejects local state, traversal, unexpected file types and content canaries", () => {
		for (const path of [
			".git/config",
			".pi/settings.json",
			".claude/settings.json",
			".codex/config.toml",
			"dist/cli.js",
			"node_modules/pkg/index.js",
			".forgejo-test/server.json",
			".env",
			"out.map",
			"source.tar",
			"package.tgz",
			"../outside",
			"/absolute",
			"a//b",
		])
			expect(() => checkPaths([path])).toThrow();
		const root = tempDir("fgj-public-type-");
		mkdirSync(join(root, "directory.ts"));
		expect(() => snapshotFiles(root, ["missing.ts"])).toThrow();
		expect(() => snapshotFiles(root, ["directory.ts"])).toThrow("file type");
		symlinkSync("directory.ts", join(root, "link.ts"));
		expect(() => snapshotFiles(root, ["link.ts"])).toThrow("file type");
		for (const text of [
			CANARY,
			CANARY_PARTS.map((part, i) =>
				i ? part[0]?.toUpperCase() + part.slice(1) : part,
			).join(""),
			CANARY_PARTS.join("_"),
			CANARY_PARTS.join("."),
		])
			expect(() => checkContent(text)).toThrow();
		checkContent("https://forgejo.example.com/team/repo alice@example.invalid");
	});

	test("board reference retains route and template facts without private replay identifiers", () => {
		const report = readFileSync(
			join(ROOT, "docs/board-creation-research.md"),
			"utf8",
		);
		expect(report).not.toMatch(
			/[a-f0-9]{40}|\bBackend\b|\barchitect\b|u-[a-f0-9]{8}|t-[a-f0-9]{8}|Research [a-f0-9]{8}|fgj-\d+-replay/,
		);
		expect(report).toContain("303");
		expect(report).toContain("404");
		expect(report).toContain("template_type");
	});

	test("public guidance exists and Actions fixtures contain only synthetic provenance", () => {
		for (const file of ["CONTRIBUTING.md", "SECURITY.md", "docs/uat.md"])
			expect(readFileSync(join(ROOT, file), "utf8").length).toBeGreaterThan(
				100,
			);
		for (const file of ["failed-tsc", "failed-vitest-timeout", "passed"])
			expect(
				readFileSync(join(ROOT, `test/fixtures/actions/${file}.log`), "utf8"),
			).not.toMatch(/[a-f0-9]{40}|received task|git-credentials|\/workspace\//);
	});

	test("a reviewed tree export excludes poisoned local files and has fresh history with byte-equal licenses", () => {
		const paths = command(ROOT, ["git", "ls-files", "-z"])
			.split("\0")
			.filter(Boolean);
		expect(paths.length).toBeGreaterThan(100);
		const files = snapshotFiles(ROOT, paths);
		const inventory = [...files].map(([path, bytes]) =>
			inventoryRow(path, bytes),
		);
		checkInventory(inventory, files);
		const source = tempDir("fgj-public-source-");
		for (const [path, bytes] of files) {
			checkContent(path);
			if (!bytes.includes(0)) checkContent(bytes.toString());
			mkdirSync(dirname(join(source, path)), { recursive: true });
			copyFileSync(join(ROOT, path), join(source, path));
		}
		command(source, ["git", "init", "-q"]);
		command(source, ["git", "add", "--", ...paths]);
		command(source, [
			"git",
			"-c",
			"user.name=Example Contributor",
			"-c",
			"user.email=contributor@example.invalid",
			"commit",
			"-qm",
			"Reviewed source",
		]);
		for (const path of [
			".pi/local-canary",
			"dist/local-canary",
			"node_modules/local-canary",
			".forgejo-test/local-canary",
			".git/local-canary",
		]) {
			mkdirSync(dirname(join(source, path)), { recursive: true });
			writeFileSync(join(source, path), CANARY);
		}
		const tar = join(tempDir("fgj-public-archive-"), "source.tar");
		command(source, [
			"git",
			"archive",
			"--format=tar",
			`--output=${tar}`,
			"HEAD^{tree}",
		]);
		const exported = command(source, ["tar", "-tf", tar])
			.trim()
			.split("\n")
			.filter((path) => !path.endsWith("/"));
		expect(exported.sort()).toEqual([...paths].sort());
		const metadata = Bun.spawnSync(["git", "get-tar-commit-id"], {
			stdin: Bun.file(tar),
		});
		expect(metadata.exitCode).toBe(1);
		expect(metadata.stdout.toString()).toBe("");
		const fresh = tempDir("fgj-public-fresh-");
		command(fresh, ["tar", "-xf", tar]);
		checkInventory(inventory, snapshotFiles(fresh, exported));
		for (const license of ["LICENSE-MIT", "LICENSE-APACHE"])
			expect(sha256(readFileSync(join(fresh, license)))).toBe(
				sha256(readFileSync(join(ROOT, license))),
			);
		command(fresh, ["git", "init", "-q"]);
		command(fresh, ["git", "add", "."]);
		command(fresh, [
			"git",
			"-c",
			"user.name=Example Contributor",
			"-c",
			"user.email=contributor@example.invalid",
			"commit",
			"-qm",
			"Reviewed source",
		]);
		expect(command(fresh, ["git", "rev-list", "--count", "HEAD"]).trim()).toBe(
			"1",
		);
		expect(command(fresh, ["git", "remote", "-v"])).toBe("");
		expect(command(fresh, ["git", "log", "--format=%an <%ae>"])).toBe(
			"Example Contributor <contributor@example.invalid>\n",
		);
	}, 120_000);

	test("the exact npm archive and generated help, rules and skill retain licenses without maps or local paths", () => {
		const home = tempDir("fgj-public-artifact-");
		const tarball = reviewedTarball();
		const before = sha256(readFileSync(tarball));
		const paths = command(ROOT, ["tar", "-tzf", tarball]).trim().split("\n");
		expect(paths.sort()).toEqual([
			"package/LICENSE-APACHE",
			"package/LICENSE-MIT",
			"package/README.md",
			"package/cli.js",
			"package/package.json",
		]);
		command(ROOT, ["tar", "-xzf", tarball, "-C", home]);
		const contents = paths.map(
			(path) => `${path}\n${readFileSync(join(home, path), "utf8")}`,
		);
		// Generated pi callbacks name the current runtime, not the build machine.
		const runtime = join(home, "bun");
		copyFileSync(process.execPath, runtime);
		chmodSync(runtime, 0o755);
		for (const argv of [
			["help"],
			["skill", "show"],
			...["codex", "claude"].map((harness) => ["rules", "show", harness]),
		])
			contents.push(
				command(ROOT, [
					runtime,
					"--no-env-file",
					"--config=/dev/null",
					join(home, "package/cli.js"),
					...argv,
				]),
			);
		const pi = command(ROOT, [
			runtime,
			"--no-env-file",
			"--config=/dev/null",
			join(home, "package/cli.js"),
			"rules",
			"show",
			"pi",
		]);
		expect(pi).toContain(runtime);
		contents.push(pi.replaceAll(runtime, "<bun>"));
		for (const text of contents) {
			checkContent(text);
			expect(text).not.toMatch(
				/(?:\/Users\/|\/home\/)[^\s"']+|sourceMappingURL=|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|(?:ghp_|github_pat_)[A-Za-z0-9_]+/,
			);
		}
		for (const license of ["LICENSE-MIT", "LICENSE-APACHE"])
			expect(readFileSync(join(home, "package", license))).toEqual(
				readFileSync(join(ROOT, license)),
			);
		expect(sha256(readFileSync(tarball))).toBe(before);
	}, 120_000);
});

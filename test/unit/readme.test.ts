import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { docFiles } from "../../scripts/docs-check.ts";
import {
	VERBS_END,
	VERBS_START,
	verbTable,
	withVerbTable,
} from "../../scripts/readme-verbs.ts";
import { signature } from "../../src/core/help.ts";
import { MANIFEST } from "../../src/verbs/manifest.ts";

describe("README verb table", () => {
	test("the table has one row per verb, with its signature and summary", () => {
		const rows = verbTable(MANIFEST)
			.split("\n")
			.filter((l) => l.startsWith("| `fgj "));
		expect(rows).toHaveLength(MANIFEST.length);
		const first = MANIFEST[0];
		if (!first) throw new Error("empty manifest");
		expect(rows[0]).toBe(`| \`${signature(first)}\` | ${first.summary} |`);
	});

	test("a | in a summary does not split the row", () => {
		const first = MANIFEST[0];
		if (!first) throw new Error("empty manifest");
		const table = verbTable([{ ...first, summary: "a | b" }]);
		expect(table).toContain("| a \\| b |");
	});

	test("the table replaces only the text between the markers", () => {
		const text = `# x\n\n${VERBS_START}\nold\n${VERBS_END}\n\nafter\n`;
		expect(withVerbTable(text, "new")).toBe(
			`# x\n\n${VERBS_START}\nnew\n${VERBS_END}\n\nafter\n`,
		);
		expect(() => withVerbTable("# x\n", "new")).toThrow(VERBS_START);
	});

	test("README.md shows the table for the current manifest", () => {
		const readme = readFileSync(
			join(import.meta.dir, "../../README.md"),
			"utf8",
		);
		// On a failure, run: bun run docs:verbs
		expect(readme).toBe(withVerbTable(readme, verbTable(MANIFEST)));
	});
});

test("GitHub selects the root README rather than a directory guide", async () => {
	const files = await docFiles(join(import.meta.dir, "../.."));
	const githubReadmes = files.filter((file) =>
		/^\.github\/readme(?:\.[^/]+)?$/i.test(file),
	);
	expect(githubReadmes).toEqual([]);
	expect(files).toContain("README.md");
});

test("the public quick start leads to native downloads before account setup", () => {
	const root = join(import.meta.dir, "../..");
	const readme = readFileSync(join(root, "README.md"), "utf8");
	const start =
		readme
			.split("<!-- getting-started:start -->")[1]
			?.split("<!-- getting-started:end -->")[0] ?? "";
	expect(readme).toContain("/releases/tag/v0.1.0");
	expect(start).toContain("docs/native.md");
	expect(start).toContain("1. Install the matching [native download]");
	expect(start).toContain("fgj version\n   fgj help");
	const native = readFileSync(join(root, "docs/native.md"), "utf8");
	for (const platform of ["macos-arm64", "linux-arm64", "linux-x64"])
		expect(native).toContain(`fgj-0.1.0-${platform}.tar.gz`);
	expect(native).toContain("sha256sum -c");
	expect(native).toContain("shasum -a 256 -c");
});

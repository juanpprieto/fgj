import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	checkDocs,
	docFiles,
	type Exclusion,
	linksOf,
	readConfig,
	tsdocIssues,
} from "../../scripts/docs-check.ts";
import { tempDir } from "../support/tmp.ts";

/** Writes a small repository and returns its root and file list. */
function repo(files: Record<string, string>): { root: string; list: string[] } {
	const root = tempDir("fgj-docs-");
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), text);
	}
	return { root, list: Object.keys(files).sort() };
}

const check = (files: Record<string, string>, exclusions: Exclusion[] = []) => {
	const { root, list } = repo(files);
	return checkDocs(root, list, exclusions).map((i) => `${i.path} ${i.code}`);
};

const DOC = `/**
 * Adds two numbers.
 *
 * @param a - The first.
 * @param b - The second.
 * @returns The sum.
 * @example
 * add(1, 2); // 3
 */`;

describe("docs check: READMEs", () => {
	test("a clean tree has no issue", () => {
		expect(
			check({
				"README.md": "[`src/`](src/README.md) and [the lib](lib/README.md#top)",
				"src/README.md": "[`a.ts`](./a.ts)",
				"src/a.ts": `${DOC}\nexport function add(a: number, b: number) { return a + b; }\n`,
				"lib/README.md": '[`b.md`](b.md "title")',
				"lib/b.md": "text",
			}),
		).toEqual([]);
	});

	test("the GitHub directory guide uses overview without disabling nested README checks", () => {
		const files = {
			"README.md": "[GitHub](.github/overview.md)",
			".github/overview.md": "[workflows](workflows/README.md)",
			".github/workflows/README.md": "[CI](contributor.yml)",
			".github/workflows/contributor.yml": "name: contributor\n",
		};
		expect(check(files)).toEqual([]);
		expect(check({ ...files, ".github/overview.md": "No links." })).toEqual([
			".github/overview.md missing-map-entry",
		]);
		expect(
			check({ ...files, ".github/overview.md": "[gone](gone.md)" }),
		).toContain(".github/overview.md broken-link");
		const { ".github/workflows/README.md": _readme, ...missing } = files;
		expect(check(missing)).toContain(
			".github/workflows/README.md missing-readme",
		);
	});
	test("a directory without a README is missing-readme, and its parent must link it", () => {
		expect(
			check({ "README.md": "No links.", "src/a.ts": "const x = 1;\n" }),
		).toEqual(["README.md missing-map-entry", "src/README.md missing-readme"]);
	});

	test("a child named only in backticks or in a code block is not linked", () => {
		expect(
			check({
				"README.md": "`a.md` holds text.\n\n```\n[a.md](a.md)\n```\n",
				"a.md": "text",
			}),
		).toEqual(["README.md missing-map-entry"]);
	});

	test("a link to a missing file, or out of the repository, is broken-link; web links and anchors are not checked", () => {
		// The outside target exists on disk, so only the repository rule can fail it.
		const outside = tempDir("fgj-docs-outside-");
		writeFileSync(join(outside, "x.md"), "text");
		expect(
			check({
				"README.md": `[a](a.md) [gone](gone.md) [up](../${basename(outside)}/x.md) [web](https://x.dev/y) [top](#top) [mail](mailto:a@b.c)`,
				"a.md": "text",
			}),
		).toEqual(["README.md broken-link", "README.md broken-link"]);
	});

	test("a link counts only when git lists its target, with the same letter case", () => {
		const { root, list } = repo({
			"README.md": "[a](a.md) [A](A.md) [d](dist/fgj) [dist](dist/)",
			"a.md": "text",
		});
		// On disk but ignored by git, so not in the file list.
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "dist/fgj"), "binary");
		expect(checkDocs(root, list, []).map((i) => i.message)).toEqual([
			"Fix the link A.md: no such file in the repository.",
			"Fix the link dist/: no such file in the repository.",
			"Fix the link dist/fgj: no such file in the repository.",
		]);
	});

	test("a link that starts with // points to another host, so the check skips it", () => {
		expect(check({ "README.md": "[x](//example.com/a)" })).toEqual([]);
	});

	test("a link that starts with / is broken, because Forgejo reads it from the host root", () => {
		const { root, list } = repo({
			"README.md": "[docs](docs/README.md)",
			"docs/README.md": "[self](/README.md) [design](/docs/README.md)",
		});
		expect(checkDocs(root, list, []).map((i) => i.message)).toEqual([
			"Fix the link /docs/README.md: make it relative; Forgejo reads / from the host root.",
			"Fix the link /README.md: make it relative; Forgejo reads / from the host root.",
		]);
	});
});

describe("docs check: exclusions", () => {
	test("an excluded directory needs no README and no link from its parent", () => {
		expect(
			check({ "README.md": "No links.", "test/unit/a.test.ts": "" }, [
				{ path: "test", reason: "Described in the root README." },
			]),
		).toEqual([]);
	});

	test("an exclusion needs a reason, a path inside the repository, and a file that it matches", () => {
		const files = { "README.md": "[a](a.md)", "a.md": "text" };
		expect(
			checkDocs(repo(files).root, Object.keys(files), [
				{ path: "a.md", reason: " " },
				{ path: "../a.md", reason: "Outside." },
				{ path: "/a.md", reason: "Absolute." },
				{ path: "gone", reason: "Stale." },
				{ path: ".", reason: "Everything." },
			]).map((i) => `${i.path}: ${i.message}`),
		).toEqual([
			".: Give each exclusion a repository-relative path and a reason.",
			"../a.md: Keep the exclusion path inside the repository.",
			"/a.md: Keep the exclusion path inside the repository.",
			"a.md: Give each exclusion a repository-relative path and a reason.",
			"gone: Remove the exclusion: no file matches it.",
		]);
	});

	test("an excluded source file still needs its TSDoc", () => {
		expect(
			check(
				{
					"README.md": "No links.",
					"src/a.ts": "export function add(a: number) { return a; }\n",
				},
				[{ path: "src", reason: "Test." }],
			),
		).toEqual(["src/a.ts missing-tsdoc"]);
	});
});

describe("docs check: TSDoc", () => {
	const issues = (text: string, file = "src/a.ts") => {
		const { root } = repo({ [file]: text });
		return tsdocIssues(root, file).map((i) => i.message);
	};

	test("an exported function needs a summary, a @param per parameter, @returns, and @example", () => {
		expect(
			issues(
				"/** @param a - One. */\nexport function add(a: number, b: number) { return a + b; }\n",
			),
		).toEqual([
			"Add a summary, @param, @returns, @example to the TSDoc of add on line 2.",
		]);
		expect(
			issues(
				`${DOC}\nexport function add(a: number, b: number) { return a + b; }\n`,
			),
		).toEqual([]);
	});

	test("exported arrow functions, callable types, and public methods count; data, private methods, and local functions do not", () => {
		const text = [
			"export const run = (x: number) => x;",
			"export type Read = (path: string) => string;",
			"export interface Call { (x: number): number; name: string }",
			"export interface Data { name: string }",
			"export const LIMIT = 6000;",
			"function local(a: number) { return a; }",
			"export class Api {",
			"  constructor(private readonly url: string) {}",
			"  get(path: string) { return path; }",
			"  private secret(a: number) { return a; }",
			"  #hidden(a: number) { return a; }",
			"}",
		].join("\n");
		expect(issues(text)).toEqual([
			"Add a summary, @param, @returns, @example to the TSDoc of run on line 1.",
			"Add a summary, @param, @returns, @example to the TSDoc of Read on line 2.",
			"Add a summary, @param, @returns, @example to the TSDoc of Call on line 3.",
			"Add a summary, @param, @example to the TSDoc of constructor on line 8.",
			"Add a summary, @param, @returns, @example to the TSDoc of get on line 9.",
		]);
	});

	test("each parameter needs a @param with its own name; a destructured one needs a tag of its own", () => {
		const head = "/**\n * Does it.\n *";
		const tail = " * @returns It.\n * @example\n * f();\n */";
		const fn = (tags: string, params: string) =>
			issues(`${head}\n${tags}\n${tail}\nexport function f(${params}) {}\n`);
		const stale = "Add @param to the TSDoc of f on line 10.";
		expect(fn(" * @param path - Stale.", "file: string")).toEqual([
			stale.replace("line 10", "line 9"),
		]);
		expect(
			fn(" * @param a - One.\n * @param a - Again.", "a: number, b: number"),
		).toEqual([stale]);
		expect(
			fn(
				" * @param a - One.\n * @param opts.x - Nested.",
				"a: number, { x }: { x: number }",
			),
		).toEqual([stale]);
		expect(
			fn(
				" * @param a - One.\n * @param opts - The options.",
				"a: number, { x }: { x: number }",
			),
		).toEqual([]);
		expect(fn(" * @param a - One.", "this: Window, a: number")).toEqual([]);
	});

	test("a local function exported by name counts, and an overload list is checked once", () => {
		const text = [
			"function a(x: number) { return x; }",
			"export { a };",
			`${DOC}`,
			"export function add(a: number, b: number): number;",
			"export function add(a: string, b: string): string;",
			"export function add(a: any, b: any) { return a + b; }",
		].join("\n");
		expect(issues(text)).toEqual([
			"Add a summary, @param, @returns, @example to the TSDoc of a on line 1.",
		]);
	});

	test("an overload list carries its TSDoc on the first signature, also when exported by name or in a class", () => {
		const doc =
			"/**\n * Adds.\n *\n * @param a - A.\n * @returns It.\n * @example\n * f(1);\n */";
		const text = [
			doc,
			"function f(a: number): number;",
			"function f(a: string): string;",
			"function f(a: any) { return a; }",
			"export { f };",
			"export class K {",
			`  ${doc}`,
			"  m(a: number): number;",
			"  m(a: string): string;",
			"  m(a: any) { return a; }",
			"}",
		].join("\n");
		expect(issues(text)).toEqual([]);
	});

	test("a default-exported arrow, a class property arrow, and a wrapped arrow count", () => {
		expect(issues("export default (a: number) => a;\n")).toEqual([
			"Add a summary, @param, @returns, @example to the TSDoc of the default export on line 1.",
		]);
		expect(
			issues(
				"export class K {\n  run = (a: number) => a;\n  private hide = (a: number) => a;\n}\n",
			),
		).toEqual([
			"Add a summary, @param, @returns, @example to the TSDoc of run on line 2.",
		]);
		expect(
			issues(
				"type F = (a: number) => number;\nexport const f = ((a: number) => a) satisfies F;\n",
			),
		).toEqual([
			"Add a summary, @param, @returns, @example to the TSDoc of f on line 2.",
		]);
	});

	test("a static member and an instance member with one name are checked apart", () => {
		const doc =
			"/**\n * Makes one.\n *\n * @returns It.\n * @example\n * K.create();\n */";
		expect(
			issues(
				`export class K {\n  ${doc}\n  static create() {}\n  create(bad: number) {}\n}\n`,
			),
		).toEqual([
			"Add a summary, @param, @returns, @example to the TSDoc of create on line 10.",
		]);
	});

	test("the check reads src, scripts, and test/support, and skips tests and declaration files", () => {
		const bad = "export function f(a: number) { return a; }\n";
		expect(
			check({
				"README.md":
					"[src](src/README.md) [scripts](scripts/README.md) [test](test/README.md)",
				"src/README.md": "[a.test.ts](a.test.ts) [b.d.ts](b.d.ts)",
				"src/a.test.ts": bad,
				"src/b.d.ts": "export declare function f(a: number): number;\n",
				"scripts/README.md": "[c.ts](c.ts)",
				"scripts/c.ts": bad,
				"test/README.md": "[support](support/README.md)",
				"test/support/README.md": "[d.ts](d.ts)",
				"test/support/d.ts": bad,
			}),
		).toEqual([
			"scripts/c.ts missing-tsdoc",
			"test/support/d.ts missing-tsdoc",
		]);
	});
});

describe("docs check: links", () => {
	test("links come from outside code, with an optional title and angle brackets", () => {
		expect(
			linksOf(
				'[a](a.md) [b](<b c.md>) [c](c.md "C") `[d](d.md)`\n~~~\n[e](e.md)\n~~~\n',
			),
		).toEqual(["a.md", "b%20c.md", "c.md"]);
	});

	test("a Markdown parser finds reference links, any title style, HTML links, and images, and skips all code", () => {
		const md = [
			"[c](c.md 'C') [p](p.md (P)) [r][1] <a href=\"h.md\">h</a> ![i](i.png) ``[s](s.md)``",
			"",
			"- item",
			"",
			"  ```",
			"  [f](f.md)",
			"  ```",
			"",
			"````",
			"```",
			"[q](q.md)",
			"````",
			"",
			"    [ind](ind.md)",
			"",
			"[1]: ref.md",
		].join("\n");
		expect(linksOf(md).sort()).toEqual([
			"c.md",
			"h.md",
			"i.png",
			"p.md",
			"ref.md",
		]);
	});

	test("HTML links: entities are decoded, comments skipped, any quote or letter case, and only href or src", () => {
		const md = [
			"[ap](it's.md)",
			'<a href="q&quot;.md">q</a>',
			'<!-- <a href="commented.md">x</a> -->',
			"<a href='single.md'>s</a>",
			'<A HREF="upper.md">u</A>',
			'<img alt="x" data-src="datasrc.png" src="real.png">',
		].join("\n\n");
		expect(linksOf(md).sort()).toEqual([
			"it's.md",
			'q".md',
			"real.png",
			"single.md",
			"upper.md",
		]);
	});

	test("entities decode in one pass, and a code point out of range stays as text", () => {
		expect(
			linksOf(
				'<a href="a&#38;quot;b.md">x</a> <a href="c&#38;amp;d.md">y</a> <a href="&#99999999;.md">z</a>',
			),
		).toEqual(["a&quot;b.md", "c&amp;d.md", "&#99999999;.md"]);
	});
});

describe("docs check: files and config", () => {
	test("docFiles lists tracked and untracked files, and skips ignored files and deleted ones", async () => {
		const root = tempDir("fgj-docs-git-");
		const git = (...args: string[]) =>
			Bun.spawnSync(["git", "-C", root, ...args], { stdout: "ignore" });
		git("init", "-q");
		for (const [name, text] of Object.entries({
			".gitignore": "dist/\n",
			"kept.md": "a",
			"gone.md": "b",
			"new file.md": "c",
			"dist/fgj": "d",
		})) {
			mkdirSync(dirname(join(root, name)), { recursive: true });
			writeFileSync(join(root, name), text);
		}
		git("add", ".gitignore", "kept.md", "gone.md");
		rmSync(join(root, "gone.md"));
		expect(await docFiles(root)).toEqual([
			".gitignore",
			"kept.md",
			"new file.md",
		]);
	});

	test("a config without an exclusions list fails with a clear message", () => {
		const root = tempDir("fgj-docs-config-");
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "scripts/docs-check.json"), "{}");
		expect(() => readConfig(root)).toThrow(
			"scripts/docs-check.json needs an exclusions list.",
		);
		writeFileSync(join(root, "scripts/docs-check.json"), "{bad");
		expect(() => readConfig(root)).toThrow(
			"scripts/docs-check.json is not valid JSON:",
		);
		writeFileSync(join(root, "scripts/docs-check.json"), '{"exclusions":[]}');
		expect(readConfig(root)).toEqual([]);
	});
});

#!/usr/bin/env bun
/**
 * Checks the documentation rules in AGENTS.md and changes no file:
 * - every directory has an index that links each direct child file and directory:
 *   README.md, except .github/overview.md to preserve GitHub's root README;
 * - every local link in a README works;
 * - every exported function and callable type has TSDoc with a summary,
 *   `@param` for each parameter, `@returns`, and `@example`.
 *
 * It reads every tracked file and every untracked file that git does not
 * ignore, so a new file counts before `git add`. `scripts/docs-check.json`
 * lists the paths that the README rules skip, each with a reason; the TSDoc
 * rule still checks them. It prints one line per issue and exits 1 when it
 * finds any.
 * Usage: bun scripts/docs-check.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const README = "README.md";

/** GitHub selects a .github README before the root README, so its guide needs another name. */
function indexName(dir: string): string {
	return dir === ".github" ? "overview.md" : README;
}
/** A path that the README rules skip, with the reason. */
export interface Exclusion {
	path: string;
	reason: string;
}

/** The kind of a documentation issue. */
export type IssueCode =
	| "broken-link"
	| "invalid-exclusion"
	| "missing-map-entry"
	| "missing-readme"
	| "missing-tsdoc";

/** One documentation issue: its kind, the file, and the fix. */
export interface Issue {
	code: IssueCode;
	path: string;
	message: string;
}

/**
 * Checks the documentation rules for a list of repository files.
 *
 * @param root - The absolute repository root.
 * @param files - The repository-relative files to check.
 * @param exclusions - The paths that the README rules skip, each with a reason.
 * @returns Every issue, sorted by path, code, and message.
 * @example
 * checkDocs("/repo", ["README.md", "src/cli.ts"], []);
 */
export function checkDocs(
	root: string,
	files: readonly string[],
	exclusions: readonly Exclusion[],
): Issue[] {
	const skip = checkExclusions(exclusions, files);
	const kept = files.filter((f) => !skip.paths.some((p) => within(f, p)));
	const dirs = directoriesOf(kept);
	// Link targets resolve against what git lists, not the disk: an ignored
	// file, or a name in another letter case, is broken on the server.
	const known = new Set([...files, ...directoriesOf(files)]);
	const issues = [...skip.issues];
	for (const dir of dirs) {
		const readme = dir === "." ? README : `${dir}/${indexName(dir)}`;
		if (!kept.includes(readme) || !existsSync(path.join(root, readme))) {
			issues.push({
				code: "missing-readme",
				path: readme,
				message: `Add ${readme}: what the directory owns and what it does not. Or add a reasoned exclusion to scripts/docs-check.json.`,
			});
			continue;
		}
		const links = linksOf(readFileSync(path.join(root, readme), "utf8"));
		issues.push(...mapIssues(readme, dir, links, kept, dirs));
		issues.push(...linkIssues(readme, links, known));
	}
	for (const file of files) {
		if (isSource(file)) issues.push(...tsdocIssues(root, file));
	}
	return issues.sort(
		(a, b) =>
			a.path.localeCompare(b.path) ||
			a.code.localeCompare(b.code) ||
			a.message.localeCompare(b.message),
	);
}

function within(file: string, dir: string): boolean {
	return file === dir || file.startsWith(`${dir}/`);
}

function checkExclusions(
	exclusions: readonly Exclusion[],
	files: readonly string[],
): { paths: string[]; issues: Issue[] } {
	const paths: string[] = [];
	const issues: Issue[] = [];
	for (const e of exclusions) {
		const p = String(e.path ?? "").replace(/\/+$/, "");
		const fail = (message: string) =>
			issues.push({ code: "invalid-exclusion", path: p || "<empty>", message });
		if (!p || p === "." || !String(e.reason ?? "").trim()) {
			fail("Give each exclusion a repository-relative path and a reason.");
		} else if (path.isAbsolute(p) || p.split("/").includes("..")) {
			fail("Keep the exclusion path inside the repository.");
		} else if (!files.some((f) => within(f, p))) {
			fail("Remove the exclusion: no file matches it.");
		} else {
			paths.push(p);
		}
	}
	return { paths, issues };
}

function directoriesOf(files: readonly string[]): string[] {
	const dirs = new Set<string>(["."]);
	for (const file of files) {
		for (let d = path.posix.dirname(file); d !== "."; d = path.posix.dirname(d))
			dirs.add(d);
	}
	return [...dirs].sort();
}

/**
 * Finds the link and image targets in Markdown, outside code, with Bun's
 * Markdown parser: inline and reference links, any title style, and HTML links.
 *
 * @param markdown - The Markdown text.
 * @returns The targets as the parser gives them, for example `b%20c.md`.
 * @example
 * linksOf("See [the design](docs/design.md)."); // ["docs/design.md"]
 */
export function linksOf(markdown: string): string[] {
	const html = Bun.markdown.html(markdown).replace(/<!--[\s\S]*?-->/g, "");
	return [
		...html.matchAll(
			/<(?:a|img)\s[^>]*?(?<![\w-])(?:href|src)=(["'])(.*?)\1/gi,
		),
	].map((m) => decodeEntities(m[2] ?? ""));
}

const ENTITIES: Record<string, string> = {
	quot: '"',
	apos: "'",
	lt: "<",
	gt: ">",
	amp: "&",
};

/**
 * Decodes the HTML entities in an attribute value in one pass, so a decoded
 * `&` never starts a second entity. A code point out of range stays as text.
 */
function decodeEntities(value: string): string {
	return value.replace(
		/&(?:#x([\da-f]+)|#(\d+)|(quot|apos|lt|gt|amp));/gi,
		(text, hex?: string, dec?: string, name?: string) => {
			if (name) return ENTITIES[name.toLowerCase()] ?? text;
			const code = hex ? Number.parseInt(hex, 16) : Number(dec);
			return code <= 0x10ffff ? String.fromCodePoint(code) : text;
		},
	);
}

/** A local target without its anchor, query, `./`, or trailing slash. */
function localTarget(target: string): string | undefined {
	const bare = target.split("#")[0]?.split("?")[0] ?? "";
	try {
		return decodeURIComponent(bare.replace(/^\.\//, "").replace(/\/+$/, ""));
	} catch {
		return undefined;
	}
}

function isExternal(target: string): boolean {
	// A `//host/path` link points to another host.
	return (
		target.startsWith("#") ||
		target.startsWith("//") ||
		/^[a-z][a-z\d+.-]*:/i.test(target)
	);
}

function mapIssues(
	readme: string,
	dir: string,
	links: readonly string[],
	files: readonly string[],
	dirs: readonly string[],
): Issue[] {
	const linked = new Set(
		links.filter((l) => !isExternal(l)).map((l) => localTarget(l)),
	);
	const children = new Map<string, boolean>();
	for (const d of dirs) {
		if (d !== "." && path.posix.dirname(d) === dir)
			children.set(path.posix.basename(d), true);
	}
	for (const f of files) {
		if (path.posix.dirname(f) === dir && f !== readme)
			children.set(path.posix.basename(f), false);
	}
	return [...children]
		.filter(
			([name, isDir]) =>
				!linked.has(name) &&
				!(
					isDir &&
					linked.has(`${name}/${indexName(path.posix.join(dir, name))}`)
				),
		)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name]) => ({
			code: "missing-map-entry",
			path: readme,
			message: `Link ${name} from ${readme}, with what it holds.`,
		}));
}

function linkIssues(
	readme: string,
	links: readonly string[],
	known: ReadonlySet<string>,
): Issue[] {
	const base = path.posix.dirname(readme);
	const issues: Issue[] = [];
	for (const link of links) {
		if (isExternal(link)) continue;
		if (link.startsWith("/")) {
			issues.push({
				code: "broken-link",
				path: readme,
				message: `Fix the link ${link}: make it relative; Forgejo reads / from the host root.`,
			});
			continue;
		}
		const target = localTarget(link);
		const full =
			target === undefined
				? ""
				: path.posix.normalize(path.posix.join(base, target));
		if (target === undefined || !known.has(full)) {
			issues.push({
				code: "broken-link",
				path: readme,
				message: `Fix the link ${link}: no such file in the repository.`,
			});
		}
	}
	return issues;
}

function isSource(file: string): boolean {
	return (
		/^(src|scripts|test\/support)\/.*\.ts$/.test(file) &&
		!file.endsWith(".test.ts") &&
		!file.endsWith(".d.ts")
	);
}

/**
 * Finds the exported functions and callable types in one TypeScript file
 * that lack a TSDoc summary, a `@param` per parameter, `@returns`, or
 * `@example`.
 *
 * @param root - The absolute repository root.
 * @param file - The repository-relative `.ts` file.
 * @returns One issue per declaration that lacks a part.
 * @example
 * tsdocIssues("/repo", "src/cli.ts"); // []
 */
export function tsdocIssues(root: string, file: string): Issue[] {
	const text = readFileSync(path.join(root, file), "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const local = new Map<string, ts.Statement>();
	for (const s of source.statements) {
		// An overload list carries its TSDoc on the first signature.
		for (const name of namesOf(s)) if (!local.has(name)) local.set(name, s);
	}
	const exported = new Set<ts.Statement>();
	for (const s of source.statements) {
		if (hasModifier(s, ts.SyntaxKind.ExportKeyword)) exported.add(s);
		if (
			ts.isExportDeclaration(s) &&
			!s.moduleSpecifier &&
			s.exportClause &&
			ts.isNamedExports(s.exportClause)
		) {
			for (const e of s.exportClause.elements) {
				const target = local.get((e.propertyName ?? e.name).text);
				if (target) exported.add(target);
			}
		}
		if (ts.isExportAssignment(s) && ts.isIdentifier(s.expression)) {
			const target = local.get(s.expression.text);
			if (target) exported.add(target);
		} else if (ts.isExportAssignment(s)) {
			exported.add(s);
		}
	}
	const issues: Issue[] = [];
	const seen = new Set<string>();
	for (const s of exported) {
		if (ts.isFunctionDeclaration(s) && s.name) {
			if (seen.has(s.name.text)) continue;
			seen.add(s.name.text);
		}
		for (const [node, params] of callablesOf(s)) {
			const missing = missingParts(node, params);
			if (missing.length === 0) continue;
			const { line } = source.getLineAndCharacterOfPosition(
				node.getStart(source),
			);
			issues.push({
				code: "missing-tsdoc",
				path: file,
				message: `Add ${missing.join(", ")} to the TSDoc of ${nameOf(node)} on line ${line + 1}.`,
			});
		}
	}
	return issues;
}

function namesOf(s: ts.Statement): string[] {
	if (ts.isVariableStatement(s)) {
		return s.declarationList.declarations.flatMap((d) =>
			ts.isIdentifier(d.name) ? [d.name.text] : [],
		);
	}
	const named = s as { name?: ts.Node };
	return named.name && ts.isIdentifier(named.name) ? [named.name.text] : [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node) ?? []).some((m) => m.kind === kind)
	);
}

type Params = readonly ts.ParameterDeclaration[];

/** Each callable in an exported statement: the node that holds the TSDoc, and its parameters. */
function callablesOf(s: ts.Statement): [ts.Node, Params][] {
	if (ts.isFunctionDeclaration(s)) return [[s, s.parameters]];
	if (ts.isExportAssignment(s)) {
		const fn = functionOf(s.expression);
		return fn ? [[s, fn.parameters]] : [];
	}
	if (ts.isVariableStatement(s)) {
		const fns = s.declarationList.declarations.flatMap((d) => {
			const fn = functionOf(d.initializer);
			return fn ? [fn] : [];
		});
		return fns.length > 0 ? [[s, fns.flatMap((f) => [...f.parameters])]] : [];
	}
	if (ts.isTypeAliasDeclaration(s)) {
		const call = callSignature(s.type);
		return call ? [[s, call.parameters]] : [];
	}
	if (ts.isInterfaceDeclaration(s)) {
		const call = s.members.find(ts.isCallSignatureDeclaration);
		return call ? [[s, call.parameters]] : [];
	}
	if (ts.isClassDeclaration(s)) {
		const found: [ts.Node, Params][] = [];
		const seen = new Set<string>();
		for (const m of s.members) {
			if (
				hasModifier(m, ts.SyntaxKind.PrivateKeyword) ||
				hasModifier(m, ts.SyntaxKind.ProtectedKeyword) ||
				(m.name && ts.isPrivateIdentifier(m.name))
			)
				continue;
			const params = ts.isPropertyDeclaration(m)
				? functionOf(m.initializer)?.parameters
				: ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)
					? m.parameters
					: undefined;
			// An overload list carries its TSDoc on the first signature.
			const statics = hasModifier(m, ts.SyntaxKind.StaticKeyword);
			const key = `${statics ? "static " : ""}${m.name?.getText() ?? "constructor"}`;
			if (!params || seen.has(key)) continue;
			seen.add(key);
			found.push([m, params]);
		}
		return found;
	}
	return [];
}

/** The function in an expression, through parentheses, `as`, and `satisfies`. */
function functionOf(
	e: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
	while (
		e &&
		(ts.isParenthesizedExpression(e) ||
			ts.isAsExpression(e) ||
			ts.isSatisfiesExpression(e))
	)
		e = e.expression;
	return e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
		? e
		: undefined;
}

function callSignature(
	type: ts.TypeNode,
): ts.FunctionTypeNode | ts.CallSignatureDeclaration | undefined {
	if (ts.isFunctionTypeNode(type)) return type;
	if (ts.isTypeLiteralNode(type))
		return type.members.find(ts.isCallSignatureDeclaration);
	return undefined;
}

function missingParts(node: ts.Node, params: Params): string[] {
	const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
	const tags = docs.flatMap((d) => [...(d.tags ?? [])]);
	const has = (name: string) => tags.some((t) => t.tagName.text === name);
	const missing: string[] = [];
	if (!docs.some((d) => ts.getTextOfJSDocComment(d.comment)?.trim()))
		missing.push("a summary");
	if (!paramsDocumented(tags, params)) missing.push("@param");
	if (!ts.isConstructorDeclaration(node) && !has("returns"))
		missing.push("@returns");
	if (!has("example")) missing.push("@example");
	return missing;
}

/**
 * True when each named parameter has a `@param` with its name, and each
 * destructured parameter has a top-level `@param` of its own. A `this`
 * parameter needs none; a nested tag such as `opts.x` counts for no parameter.
 */
function paramsDocumented(
	tags: readonly ts.JSDocTag[],
	params: Params,
): boolean {
	const names = tags
		.filter(ts.isJSDocParameterTag)
		.flatMap((t) => (ts.isIdentifier(t.name) ? [t.name.text] : []));
	const named = params.flatMap((p) =>
		ts.isIdentifier(p.name) && p.name.text !== "this" ? [p.name.text] : [],
	);
	const destructured = params.filter((p) => !ts.isIdentifier(p.name)).length;
	const spare = new Set(names.filter((n) => !named.includes(n)));
	return named.every((n) => names.includes(n)) && spare.size >= destructured;
}

function nameOf(node: ts.Node): string {
	if (ts.isConstructorDeclaration(node)) return "constructor";
	if (ts.isExportAssignment(node)) return "the default export";
	if (ts.isVariableStatement(node)) return namesOf(node).join(", ");
	const named = node as { name?: ts.Node };
	return named.name && ts.isIdentifier(named.name)
		? named.name.text
		: "the declaration";
}

/**
 * Lists the tracked files and the untracked files that git does not ignore.
 *
 * @param root - The absolute repository root.
 * @returns The repository-relative paths, sorted.
 * @example
 * const files = await docFiles(process.cwd());
 */
export async function docFiles(root: string): Promise<string[]> {
	const proc = Bun.spawn(
		[
			"git",
			"-C",
			root,
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
			"-z",
		],
		{ stdout: "pipe", stderr: "inherit" },
	);
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) throw new Error("git ls-files failed.");
	// A deleted file that is still in the index is not on disk: skip it.
	return [...new Set(out.split("\0").filter(Boolean))]
		.filter((f) => existsSync(path.join(root, f)))
		.sort();
}

/**
 * Reads the exclusions from `scripts/docs-check.json`.
 *
 * @param root - The absolute repository root.
 * @returns The exclusions.
 * @throws {Error} When the file is not valid JSON or has no `exclusions` list.
 * @example
 * const exclusions = readConfig(process.cwd());
 */
export function readConfig(root: string): Exclusion[] {
	const text = readFileSync(path.join(root, "scripts/docs-check.json"), "utf8");
	let config: { exclusions?: unknown };
	try {
		config = JSON.parse(text);
	} catch (err) {
		throw new Error(
			`scripts/docs-check.json is not valid JSON: ${err instanceof Error ? err.message : err}`,
		);
	}
	if (!Array.isArray(config.exclusions))
		throw new Error("scripts/docs-check.json needs an exclusions list.");
	return config.exclusions as Exclusion[];
}

if (import.meta.main) {
	const root = process.cwd();
	const issues = checkDocs(root, await docFiles(root), readConfig(root));
	for (const i of issues) console.log(`${i.path}: [${i.code}] ${i.message}`);
	if (issues.length > 0) {
		console.log(`${issues.length} documentation issues.`);
		process.exit(1);
	}
}

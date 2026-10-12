#!/usr/bin/env bun
/**
 * Writes the verb table in README.md from the manifest, between the
 * `verbs:start` and `verbs:end` markers. The README test fails when the table
 * and the manifest differ.
 * Usage: bun scripts/readme-verbs.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { signature } from "../src/core/help.ts";
import type { Verb } from "../src/core/verb.ts";
import { MANIFEST } from "../src/verbs/manifest.ts";

/** The marker before the generated table. */
export const VERBS_START =
	"<!-- verbs:start: bun run docs:verbs writes this table from the manifest -->";

/** The marker after the generated table. */
export const VERBS_END = "<!-- verbs:end -->";

/**
 * Builds the Markdown table of every verb: its call signature and summary, as
 * `fgj help` shows them.
 *
 * @param verbs - The verbs, in manifest order.
 * @returns The table, with no final newline.
 * @example
 * verbTable(MANIFEST).split("\n")[0]; // "| Command | What it does |"
 */
export function verbTable(verbs: readonly Verb[]): string {
	const cell = (text: string) => text.replaceAll("|", "\\|");
	return [
		"| Command | What it does |",
		"|---|---|",
		...verbs.map((v) => `| \`${signature(v)}\` | ${cell(v.summary)} |`),
	].join("\n");
}

/**
 * Puts a table between the markers in a README text.
 *
 * @param text - The README text, with both markers.
 * @param table - The table to put between them.
 * @returns The README text with the new table.
 * @throws {Error} When the text has no start marker, or no end marker after it.
 * @example
 * withVerbTable(`${VERBS_START}\nold\n${VERBS_END}`, "new"); // `${VERBS_START}\nnew\n${VERBS_END}`
 */
export function withVerbTable(text: string, table: string): string {
	const start = text.indexOf(VERBS_START);
	const end = text.indexOf(VERBS_END, start);
	if (start < 0 || end < 0) {
		throw new Error(
			`README.md needs the lines ${VERBS_START} and ${VERBS_END}.`,
		);
	}
	return `${text.slice(0, start + VERBS_START.length)}\n${table}\n${text.slice(end)}`;
}

if (import.meta.main) {
	const file = path.join(import.meta.dir, "..", "README.md");
	const text = readFileSync(file, "utf8");
	const next = withVerbTable(text, verbTable(MANIFEST));
	if (next !== text) writeFileSync(file, next);
	console.log(
		next === text
			? "README.md: the verb table is current."
			: "README.md: wrote the verb table.",
	);
}

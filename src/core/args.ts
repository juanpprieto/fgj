import { profileName } from "../auth/identity.ts";
import { FgjError } from "./errors.ts";
import type { FlagValue, ParsedArgs, Verb } from "./verb.ts";

// A leading = is left out: zsh expands =word to a command path.
const SHELL_SAFE = /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/;

/**
 * Quotes one word for a POSIX shell when it holds anything but safe characters,
 * so every `next`, `apply`, and `hint` command stays runnable as printed.
 *
 * @param word - One argument, for example a file path.
 * @returns The word, or the word in single quotes.
 * @example
 * shellQuote("/tmp/my notes.md"); // "'/tmp/my notes.md'"
 */
export function shellQuote(word: string): string {
	if (SHELL_SAFE.test(word)) return word;
	return `'${word.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Splits the argv after `fgj <risk> <noun> <action>` into positionals and flags,
 * and checks each flag against the verb. It makes no network call.
 *
 * Flags take `--name value` or `--name=value`. Every verb accepts `--json` and
 * ignores it, because the output is always JSON.
 *
 * @param rest - The argv after the action, for example `["157", "--limit", "5"]`.
 * @param verb - The verb whose flags apply.
 * @returns The positionals in order and the flags by name, without the `--`.
 * @throws {FgjError} A usage error for an unknown flag, a missing value, or a bad number.
 * @example
 * parseArgs(["157", "--limit=5"], commentList);
 * // { positionals: ["157"], flags: { limit: 5 } }
 */
export function parseArgs(rest: readonly string[], verb: Verb): ParsedArgs {
	const hint = `fgj help ${verb.noun} ${verb.action}`;
	const positionals: string[] = [];
	const flags: Record<string, FlagValue> = {};
	let as: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i] as string;
		if (token === "--json") continue;
		if (token === "--as" || token.startsWith("--as=")) {
			const value = token === "--as" ? rest[++i] : token.slice(5);
			if (!value || value.startsWith("--")) {
				throw new FgjError("usage", "Flag --as needs a profile name.", hint);
			}
			if (as !== undefined) {
				throw new FgjError("usage", "Flag --as appears twice.", hint);
			}
			as = profileName(value);
			continue;
		}
		if (/^-[^-\d]/.test(token)) {
			throw new FgjError(
				"usage",
				`Unknown flag ${token}. fgj uses long flags only, for example --limit.`,
				hint,
			);
		}
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
		const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
		const spec = verb.flags.find((f) => f.name === name);
		if (
			!spec &&
			name === "body" &&
			verb.flags.some((f) => f.name === "body-file")
		) {
			throw new FgjError(
				"usage",
				"fgj reads bodies from a file only: write the body to a file, then use --body-file PATH.",
				hint,
			);
		}
		if (!spec) {
			const valid = verb.flags.map((f) => `--${f.name}`).join(", ");
			throw new FgjError(
				"usage",
				`Unknown flag --${name}. Valid flags: ${valid}.`,
				hint,
			);
		}
		if (name in flags && spec.kind !== "list") {
			throw new FgjError("usage", `Flag --${name} appears twice.`, hint);
		}
		let value = inline;
		if (value === undefined && spec.kind !== "bool") {
			const next = rest[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				value = next;
				i++;
			}
		}
		if (spec.kind === "bool" && inline !== undefined) {
			throw new FgjError("usage", `Flag --${name} takes no value.`, hint);
		}
		if (
			spec.kind === "bool" ||
			(spec.kind === "fields" && value === undefined)
		) {
			flags[name] = true;
			continue;
		}
		if (value === undefined || value === "") {
			throw new FgjError("usage", `Flag --${name} needs a value.`, hint);
		}
		if (spec.kind === "list") {
			const before = flags[name];
			flags[name] = [...(Array.isArray(before) ? before : []), value];
			continue;
		}
		if (spec.kind === "int") {
			if (!/^\d+$/.test(value)) {
				throw new FgjError(
					"usage",
					`Flag --${name} needs a whole number, got "${value}".`,
					hint,
				);
			}
			flags[name] = Number(value);
		} else {
			flags[name] = value;
		}
	}
	return as === undefined ? { positionals, flags } : { positionals, flags, as };
}

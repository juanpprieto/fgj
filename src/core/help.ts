import { MANIFEST } from "../verbs/manifest.ts";
import { EXIT, FgjError } from "./errors.ts";
import type { FlagSpec, Verb } from "./verb.ts";
import { VERSION } from "./version.ts";

/** The exit codes by number, as help shows them. */
const EXIT_CODES = Object.fromEntries(
	Object.entries(EXIT).map(([name, code]) => [String(code), name]),
);

function flagLabel(flag: FlagSpec): string {
	const value =
		flag.value ??
		(flag.kind === "int" ? "N" : flag.kind === "bool" ? "" : "VALUE");
	return value ? `--${flag.name} ${value}` : `--${flag.name}`;
}

/**
 * Builds the call signature of a verb: risk, noun, action, arguments, and the
 * flags that it cannot run without.
 *
 * @param verb - A verb from the manifest.
 * @returns The signature, for example `fgj write comment add <issue> --body-file PATH`.
 * @example
 * signature(commentAdd); // "fgj write comment add <issue> --body-file PATH"
 */
export function signature(verb: Verb): string {
	const args = verb.args.map((a) => `<${a.name}>`);
	const required = verb.flags.filter((f) => f.required).map(flagLabel);
	return ["fgj", verb.risk, verb.noun, verb.action, ...args, ...required].join(
		" ",
	);
}

function verbMap(verbs: readonly Verb[]): Record<string, string> {
	return Object.fromEntries(verbs.map((v) => [signature(v), v.summary]));
}

/**
 * The top-level help: the grammar, every verb, `fgj help` and a pointer to the
 * setup commands' help pages, and the exit codes.
 *
 * @returns The help object. It stays under 1.5k tokens.
 * @example
 * topHelp().more; // "fgj help <noun> <action>"
 */
export function topHelp(): Record<string, unknown> {
	return {
		version: VERSION,
		grammar: "fgj <read|write|destroy> <noun> <action> <args> [--flags]",
		verbs: verbMap(MANIFEST),
		meta: {
			"fgj help [<noun> [<action>]]": "This help. Any verb also takes --help.",
			// The setup commands have their own help pages, so this list stays
			// small. An agent runs only their status and show commands.
			"fgj help <auth|rules|skill>":
				"The setup commands: profiles and sign-in, harness rules, and the skill. An agent can run only their status and show commands. A human runs the others.",
		},
		output:
			"Compact JSON on stdout. Errors: {error:{code,message,hint}} on stderr; hint is a runnable command.",
		identity: `FGJ_PROFILE from the harness, or a trailing --as <profile>. ${AS_TEXT}`,
		exit: EXIT_CODES,
		more: "fgj help <noun> <action>",
	};
}

const AS_TEXT =
	"Every result names the account in `as`. With FGJ_PROFILE set, a different --as fails (exit 7). With neither, fgj uses the host's default profile; with no default, the call fails (exit 3) until a human runs fgj auth default.";

const AUTH_META = {
	"fgj auth [--profile <name>] [<url>]":
		"A human stores a read token and a write token as one profile (named after the Forgejo user unless --profile names it), and asks whether it is the host's default. It prompts at a terminal; an agent cannot run it.",
	"fgj auth web [--profile <name>]":
		"A human signs in a profile with its password (and TOTP code) for the board verbs and run rerun. fgj keeps only the remember-me cookie. It prompts at a terminal; an agent cannot run it.",
	"fgj auth status":
		"Profiles, users, a live token and web login check, the web login's end date, the default, and the active identity here. Shows no tokens.",
	"fgj auth default <profile>":
		"A human marks the profile that calls with no FGJ_PROFILE or --as use on its host. To change it, mark another profile; to unset it, remove the profile. An agent cannot run it.",
	"fgj auth remove <profile>": "Forget one profile.",
	"fgj auth bound <profile> [on|off]":
		"A human marks a profile bound only: it acts only through a harness binder, never as the default or by --as.",
};

/** The `fgj skill` commands, for help. */
export const SKILL_META = {
	"fgj skill show": "The fgj agent skill text, built into this fgj.",
	"fgj skill status": "Per harness: missing, current, or outdated.",
	"fgj skill install <codex|claude|pi>":
		"A human reviews a diff and installs the skill. An agent cannot run it.",
};

const RULES_META = {
	"fgj rules show <codex|claude|pi>":
		"The rules fgj would install for one harness.",
	"fgj rules status":
		"Per harness: missing, current, or outdated, with the pi role files.",
	"fgj rules install <codex|claude|pi>":
		"A human reviews a diff and applies the rules. An agent cannot run it.",
	"fgj rules install pi --role <role>=<profile>":
		"A human installs a pi lane's role adapter, fgj-roles/<role>.ts. An agent cannot run it.",
};

/**
 * The help for `fgj hook`: the command that harness adapters run.
 *
 * @returns The hook help object.
 * @example
 * hookHelp().commands;
 */
export function hookHelp(): Record<string, unknown> {
	return {
		commands: {
			"fgj hook pi":
				"The fgj pi adapter runs it for a bash command that could reach fgj. It reads {command, profile?} on stdin and prints {action: pass|ask|block, effects, reason, env, approval}. approval: true means a yes needs a one-time approval for the call. It sends no request.",
		},
		note: "Agents do not need it: the harness adapter calls it.",
	};
}

/**
 * The help for `fgj rules`: its three forms and what each harness gets.
 *
 * @returns The rules help object.
 * @example
 * rulesHelp().files;
 */
export function rulesHelp(): Record<string, unknown> {
	return {
		commands: RULES_META,
		files: {
			codex: "~/.codex/rules/fgj.rules (its own file; CODEX_HOME moves it)",
			claude:
				"fgj's Bash(fgj …) entries merged into ~/.claude/settings.json, with a backup (CLAUDE_CONFIG_DIR moves it)",
			pi: "~/.pi/agent/extensions/fgj-gate.ts, and one ~/.pi/agent/fgj-roles/<role>.ts per role (PI_CODING_AGENT_DIR moves them). Exactly one fgj adapter may load in a pi session: a lane lists only its role file in extensions:. The pi files name the fgj that installed them, so another fgj path reads them as outdated.",
		},
		classes:
			"read, write, help, auth status, rules show, rules status, skill show, and skill status run with no prompt; destroy asks a human. auth, auth default, auth remove, rules install, and skill install are never pre-approved.",
	};
}

/**
 * The help for `fgj auth`: its four forms and the scopes it asks for.
 *
 * @returns The auth help object.
 * @example
 * authHelp().scopes;
 */
export function authHelp(): Record<string, unknown> {
	return {
		commands: AUTH_META,
		scopes: {
			read: "read:issue, read:repository, read:user",
			write: "write:issue, write:repository, read:user",
		},
		file: "~/.config/fgj/hosts.json (mode 0600). Env fallback: FGJ_URL with FGJ_READ_TOKEN and FGJ_WRITE_TOKEN.",
		flags:
			"--profile may come first; every other flag goes after the subcommand.",
	};
}

/**
 * The help for one noun: its verbs and their summaries.
 *
 * @param noun - A noun, for example `comment`.
 * @returns The noun's verbs.
 * @throws {FgjError} A usage error that lists the nouns, when the noun is unknown.
 * @example
 * nounHelp("comment").verbs;
 */
export function nounHelp(noun: string): Record<string, unknown> {
	const verbs = MANIFEST.filter((v) => v.noun === noun);
	if (verbs.length === 0) {
		const nouns = [...new Set(MANIFEST.map((v) => v.noun))].join(", ");
		throw new FgjError(
			"usage",
			`Unknown noun "${noun}". Nouns: ${nouns}.`,
			"fgj help",
		);
	}
	return { verbs: verbMap(verbs), more: `fgj help ${noun} <action>` };
}

/**
 * The detail help for one verb: signature, notes, arguments, flags, fields,
 * output, exit codes, and examples.
 *
 * @param verb - A verb from the manifest.
 * @returns The detail object.
 * @example
 * verbHelp(commentList).cmd; // "fgj read comment list <issue>"
 */
export function verbHelp(verb: Verb): Record<string, unknown> {
	return {
		cmd: signature(verb),
		summary: verb.summary,
		...(verb.notes ? { notes: verb.notes } : {}),
		args: Object.fromEntries(verb.args.map((a) => [a.name, a.description])),
		flags: {
			...Object.fromEntries(
				verb.flags.map((f) => [flagLabel(f), f.description]),
			),
			"--as profile": AS_TEXT,
		},
		...(verb.fields
			? { fields: { all: verb.fields.all, default: verb.fields.default } }
			: {}),
		output: verb.output,
		exit: EXIT_CODES,
		examples: verb.examples,
	};
}

/**
 * Names the verbs of a noun, for an unknown-verb error.
 *
 * @param noun - The noun from argv, if any.
 * @returns A sentence such as `Verbs for comment: list, add.`, or the noun list.
 * @example
 * verbsFor("comment"); // "Verbs for comment: list, add."
 */
export function verbsFor(noun: string | undefined): string {
	const actions = MANIFEST.filter((v) => v.noun === noun).map((v) => v.action);
	if (noun && actions.length > 0) {
		return `Verbs for ${noun}: ${actions.join(", ")}.`;
	}
	const nouns = [...new Set(MANIFEST.map((v) => v.noun))].join(", ");
	return `Nouns: ${nouns}.`;
}

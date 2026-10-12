import { PROFILE_NAME_SHAPE } from "../auth/identity.ts";
import { REPO_SLUG_SHAPE } from "../forgejo/target.ts";
import { MANIFEST } from "../verbs/manifest.ts";
import { commandsRun, envParts, type RunCommand } from "./shell.ts";

/**
 * The harness-neutral gate: it decides what a harness does with one shell
 * command. It judges only the commands that run fgj, from the command words
 * that the shell reader finds, and a command word that shell expansion builds
 * when `destroy` or `auth` is among its words. Every other command passes,
 * whatever its text. Every harness adapter (the pi extension, a Claude Code
 * hook) asks fgj through `fgj hook <harness>`, so the rules live in one tested
 * place. The gate cannot see into a script that a command runs, such as
 * `sh file`; it guards against accidents. For a call that it misses, fgj's
 * own destroy check still stops a destroy while the call keeps pi's
 * environment, and `fgj auth` needs a human at a terminal.
 */

/** What the harness does with the command. */
export type GateAction = "pass" | "ask" | "block";

/** The gate's answer for one command. */
export interface GateDecision {
	action: GateAction;
	/** What the command changes, for the approval dialog. Set for `ask`. */
	effects?: string[];
	/** Why fgj blocks the command, or what to do when no human can answer. */
	reason?: string;
	/** Env to add to the command's process: the bound profile. */
	env?: Record<string, string>;
	/** True for a destroy: after a human says yes, the adapter hands the call a one-time approval. */
	approval?: true;
}

/** The binding of a harness session or lane to one fgj profile. */
export interface Binding {
	profile: string;
}

const GENERIC = "fgj destroy has no undo.";

/**
 * The reason for an `ask` when no human can answer, such as `pi -p`. It names
 * the way forward, so an agent does not conclude that fgj cannot run.
 */
const NO_UI_REASON =
	"fgj: this command needs a human to approve it, and no one can answer here. Run each fgj command alone and plain, for example `fgj read issue get 5`; read and write calls in that form need no approval.";

/**
 * One plain `fgj destroy` call and nothing else. It lists the characters it
 * accepts, never the ones it refuses: every shell form that this misses gets
 * the generic text. Words are split by spaces and tabs only. A bare word holds
 * `A-Za-z0-9_./:@%+,=-`, and `#` after its first character, as in a URL
 * fragment. A single-quoted word holds no quote and no whitespace. Optional
 * `FGJ_*=value` env prefixes and a plain path (`~/`, `/`, `./`, or words) may
 * come before `fgj`; any other prefix, such as `PATH=`, can pick another binary.
 * Group 1 holds the words after `destroy`.
 */
const SIMPLE_CALL =
	/^[ \t]*(?:FGJ_\w*=[\w./:@%+,=-]*[ \t]+)*(?:(?:~\/|\/)?(?:[\w.-]+\/)*)?fgj[ \t]+destroy((?:[ \t]+(?:'[^'\s]*'|[\w./:@%+,=-][\w./:@%+,=#-]*))+)[ \t]*$/;

const BLANKS = /[ \t]+/;

/**
 * A word that the shell changes at run time: a variable, a `$(…)` or backtick
 * (the reader marks both as `$(…)`), a brace list, or a glob. A `[` is a glob
 * only with its `]` in the same word, so the `[` and `[[` tests stay literal.
 * After `fgj`, such a word can turn into `destroy`; as a command word, it can
 * turn into `fgj`.
 */
function expands(word: string): boolean {
	if (/[$`{*?]/.test(word)) return true;
	// One pass for each bracket, so a long word of [ stays fast.
	const open = word.indexOf("[");
	return open >= 0 && word.indexOf("]", open + 1) > open;
}

/** A word that sets FGJ_PROFILE: `FGJ_PROFILE=x` or `FGJ_PROFILE+=x`. */
const PROFILE_WORD = /^FGJ_PROFILE\+?=/;

/** Commands whose arguments can set shell variables, such as `export A=1`. */
const DECLARE = /^(?:export|declare|typeset|local|readonly)$/;

/** The reason for a headless run when a call picks FGJ_PROFILE itself. */
const PROFILE_SET_REASON =
	"fgj: this call picks the fgj account itself with FGJ_PROFILE, and no one can answer here. Remove FGJ_PROFILE from the command; a harness binder or a human picks the account.";

/**
 * Checks for a command that sets FGJ_PROFILE: an assignment before a command
 * word, an `export`-style argument, or an `env` assignment.
 */
function setsProfile(runs: readonly RunCommand[]): boolean {
	return runs.some(({ words: [name = "", ...args], assigns }) => {
		const set = [...assigns];
		if (DECLARE.test(name)) set.push(...args);
		if (name === "env") set.push(...envParts(args).assigns);
		return set.some((word) => PROFILE_WORD.test(word));
	});
}

/**
 * Checks for a command that removes FGJ_PROFILE, clears the environment, or
 * reads a new value into FGJ_PROFILE: `unset`, `export -n`, `env -u`, `env -i`,
 * `read`, `mapfile`, or `printf -v`.
 */
function dropsProfile(runs: readonly RunCommand[]): boolean {
	return runs.some(({ words: [name = "", ...args] }) => {
		if (name === "env") {
			const env = envParts(args);
			return env.clears || env.unsets.includes("FGJ_PROFILE");
		}
		if (
			name === "unset" ||
			name === "read" ||
			name === "mapfile" ||
			name === "readarray"
		) {
			return args.includes("FGJ_PROFILE");
		}
		if (name === "export") {
			return args.includes("-n") && args.includes("FGJ_PROFILE");
		}
		if (name === "printf") {
			const at = args.indexOf("-v");
			return (
				args.includes("-vFGJ_PROFILE") ||
				(at >= 0 && args[at + 1] === "FGJ_PROFILE")
			);
		}
		return false;
	});
}

const PROFILE = new RegExp(PROFILE_NAME_SHAPE);
const REPO = new RegExp(REPO_SLUG_SHAPE);

/** A destroy verb's effect, with the flags that fgj accepts for it. */
interface DestroyEffect {
	now: string;
	plan: string;
	arg: RegExp;
	/** Flags with no value. Every verb also takes `--json`. */
	bool: string[];
	/** Flags with a value. Every verb also takes `--as`. */
	value: string[];
	/** The values that a flag accepts, by `--name`. */
	shapes: Record<string, RegExp>;
}

/** Each destroy verb's effect, from the manifest, by `noun action`. */
const EFFECTS: ReadonlyMap<string, DestroyEffect> = new Map(
	MANIFEST.flatMap((v) => {
		if (v.risk !== "destroy" || !v.effect) return [];
		const names = (bool: boolean) =>
			v.flags
				.filter((f) => (f.kind === "bool") === bool)
				.map((f) => `--${f.name}`);
		const { values = {}, now, plan, arg } = v.effect;
		const effect: DestroyEffect = {
			now,
			plan,
			arg: new RegExp(arg),
			bool: ["--json", ...names(true)],
			value: ["--as", ...names(false)],
			shapes: Object.fromEntries(
				Object.entries(values).map(([name, shape]) => [
					`--${name}`,
					new RegExp(shape),
				]),
			),
		};
		return [[`${v.noun} ${v.action}`, effect] as const];
	}),
);

/**
 * Checks a value that fgj accepts for `--as` (after it lowercases the name and
 * turns other characters into `-`), for `--repo` (after it drops a trailing
 * `.git`), or for a flag with a declared shape. fgj cannot check here that the
 * profile exists.
 */
function valueAccepted(
	flag: string,
	value: string,
	shapes: Record<string, RegExp>,
): boolean {
	const shape = shapes[flag];
	if (shape !== undefined) return shape.test(value);
	if (flag === "--as") {
		return PROFILE.test(value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"));
	}
	if (flag === "--repo") {
		return REPO.test(value.endsWith(".git") ? value.slice(0, -4) : value);
	}
	return false;
}

/**
 * Names the effect of a destroy command from its text only. Shell syntax, a
 * second call, or an argument or flag that fgj cannot read can change what
 * runs, so they get the generic text and never a claim such as "--dry-run
 * writes nothing".
 */
function destroyEffects(command: string): string[] {
	const call = SIMPLE_CALL.exec(command);
	if (!call) return [GENERIC];
	const words = (call[1] ?? "")
		.trim()
		.split(BLANKS)
		.map((w) =>
			w.length > 1 && w.startsWith("'") && w.endsWith("'") ? w.slice(1, -1) : w,
		);
	const [noun, action, ...rest] = words;
	const effect = EFFECTS.get(`${noun} ${action}`);
	if (!effect) return [GENERIC];
	const args: string[] = [];
	const seen = new Set<string>();
	const values: Record<string, string> = {};
	let dryRun = false;
	for (let i = 0; i < rest.length; i++) {
		const word = rest[i] ?? "";
		if (!word.startsWith("--")) {
			args.push(word);
			continue;
		}
		const name = word.split("=")[0] ?? "";
		if (seen.has(name)) return [GENERIC];
		seen.add(name);
		if (effect.bool.includes(name)) {
			if (word !== name) return [GENERIC];
			if (name === "--dry-run") dryRun = true;
		} else if (effect.value.includes(name)) {
			const value = word === name ? rest[++i] : word.slice(name.length + 1);
			if (value === undefined || !valueAccepted(name, value, effect.shapes)) {
				return [GENERIC];
			}
			values[name] = value;
		} else return [GENERIC];
	}
	const arg = args[0];
	if (arg === undefined || args.length !== 1 || !effect.arg.test(arg)) {
		return [GENERIC];
	}
	// One pass, so a value that holds $ stays literal text.
	let missing = false;
	const fill = (text: string) =>
		text.replace(/\$(1|[a-z][a-z-]*)/g, (_, name: string) => {
			const value = name === "1" ? arg : values[`--${name}`];
			if (value === undefined) missing = true;
			return value ?? "";
		});
	const said = dryRun
		? `${fill(effect.plan)}. --dry-run writes nothing.`
		: `${fill(effect.now)}. No undo.`;
	return missing ? [GENERIC] : [said];
}

/**
 * Decides what a harness does with one shell command. It judges only the
 * commands that run fgj, as the shell reader finds them, and a command word
 * that shell expansion builds when `destroy` or `auth` is among its words;
 * every other command passes. It asks for `fgj destroy`, every `fgj auth` form
 * except `status`, and an fgj call that shell expansion can change. In a bound lane it blocks a
 * command that runs fgj and changes the account, and it adds the bound profile
 * to every command's env.
 *
 * @param command - The shell command text, as the model wrote it.
 * @param binding - The profile that this session or lane acts as, if bound.
 * @returns The action, the effects for an approval dialog, the reason, and the env.
 * @example
 * gate("fgj destroy comment delete 770").effects; // ["Deletes comment 770. No undo."]
 */
export function gate(command: string, binding?: Binding): GateDecision {
	const env = binding ? { env: { FGJ_PROFILE: binding.profile } } : {};
	const runs = commandsRun(command);
	const calls = runs.filter((run) => run.words[0] === "fgj");
	// fgj reads its first word as written and refuses an unknown one, so only a
	// word that the shell changes at run time can hide destroy or auth.
	const hidden =
		calls.some(
			(run) =>
				expands(run.words[1] ?? "") ||
				// `… | xargs fgj`: xargs adds the verb from its input.
				(run.input === true && run.words.length === 1),
		) ||
		runs.some(
			({ words: [name = "", ...args] }) =>
				expands(name) &&
				// `fgj${IFS}destroy` is one word until the shell splits it.
				(/destroy|auth/.test(name) ||
					args.some((word) => word === "destroy" || word === "auth")),
		);
	if (calls.length === 0 && !hidden) return { action: "pass", ...env };
	if (binding && (setsProfile(runs) || dropsProfile(runs))) {
		return {
			action: "block",
			reason: `fgj: this lane acts as the profile ${binding.profile}, and the binding picks the account. Run the command without setting or removing FGJ_PROFILE, and without env -i.`,
			...env,
		};
	}
	const effects: string[] = [];
	const picksProfile = !binding && setsProfile(runs);
	if (picksProfile) {
		effects.push(
			"This call picks the fgj account itself with FGJ_PROFILE; a harness binder or a human should pick it.",
		);
	}
	const destroy = calls.some((run) => run.words[1] === "destroy");
	if (destroy) effects.push(...destroyEffects(command));
	if (calls.some(({ words }) => words[1] === "auth" && words[2] !== "status")) {
		effects.push(
			"fgj auth can store or delete tokens, or change the account that calls with no profile act as.",
		);
	}
	if (hidden && !destroy) {
		effects.push(`The shell can change what this fgj call runs. ${GENERIC}`);
	}
	if (effects.length === 0) return { action: "pass", ...env };
	return {
		action: "ask",
		effects,
		reason: picksProfile ? PROFILE_SET_REASON : NO_UI_REASON,
		...env,
		...(destroy ? { approval: true as const } : {}),
	};
}

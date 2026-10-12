import type { ReadApi, WriteApi } from "../forgejo/client.ts";
import type { Remote, Target } from "../forgejo/target.ts";
import type { WebReader, WebWriter } from "../forgejo/web.ts";
import { type ErrorCode, EXIT } from "./errors.ts";

/**
 * The key of a result that some items of a many-item write failed: its value
 * is the error code of the first failure, and the exit code follows it. A
 * symbol key never prints, so the JSON stays the result alone.
 */
export const FAILED: unique symbol = Symbol("failed");

/**
 * The exit code for a result: the code of its first failed item, or ok.
 *
 * @param result - What a verb's `run` returned.
 * @returns The process exit code.
 * @example
 * exitCodeOf({ items: [], [FAILED]: "conflict" }); // 5
 */
export function exitCodeOf(result: unknown): number {
	const failed =
		typeof result === "object" && result !== null
			? (result as { [FAILED]?: ErrorCode })[FAILED]
			: undefined;
	return failed === undefined ? EXIT.ok : EXIT[failed];
}

/** The risk class. It is always argv[1]. */
export type Risk = "read" | "write" | "destroy";

/** Every risk class, in the order help lists them. */
export const RISKS: readonly Risk[] = ["read", "write", "destroy"];

/**
 * How the parser reads a flag value. `fields` takes an optional comma list;
 * `list` can repeat, and each use adds one value.
 */
export type FlagKind = "string" | "int" | "bool" | "fields" | "list";

/** One `--flag` that a verb accepts. */
export interface FlagSpec {
	name: string;
	kind: FlagKind;
	description: string;
	/** The value placeholder that help shows, for example `PATH`. Ints show `N`. */
	value?: string;
	/** True when the verb cannot run without it. Help puts it in the signature. */
	required?: boolean;
}

/** One positional argument that a verb accepts. */
export interface ArgSpec {
	name: string;
	description: string;
}

/** The fields a read verb can return, and the ones it returns by default. */
export interface FieldSpec {
	all: readonly string[];
	default: readonly string[];
}

/** A flag value after parsing: text, a whole number, or `true` for a bare flag. */
export type FlagValue = string | number | true | readonly string[];

/** The argv after `fgj <risk> <noun> <action>`, split and type-checked. */
export interface ParsedArgs {
	positionals: string[];
	flags: Record<string, FlagValue>;
	/** The profile from a trailing `--as`, which every verb accepts. */
	as?: string;
}

/** Local facts that `prepare` may use: it reads files, never the network. */
export interface LocalEnv {
	cwd: string;
	home: string | undefined;
}

/** How long a wait verb waits, in milliseconds. */
export interface WaitTimes {
	/** The longest one call waits before it returns pending. */
	cap: number;
	/** The time between two reads. */
	poll: number;
	/** How long a wait keeps looking for a check or a run that does not exist yet. */
	grace: number;
}

/**
 * What a verb gets when it runs: the resolved repository, an API client, and a
 * web client. Read verbs get a GET-only web client; write verbs can POST.
 */
export interface VerbContext<Api, Web extends WebReader = WebReader> {
	target: Target;
	api: Api;
	/** Shorter wait times for tests, from `FGJ_WAIT_TIMES`; wait verbs use their own otherwise. */
	waitTimes?: WaitTimes;
	/**
	 * The web client, for operations with no API endpoint, such as boards. It
	 * signs in from the profile's web login on first use.
	 *
	 * @returns The web client.
	 * @throws {FgjError} An auth error when the identity has no web login.
	 * @example
	 * const page = await ctx.web().page("/acme/web/projects/4");
	 */
	web(): Web;
	/**
	 * The exact fgj command line for the same call with flags changed. `undefined`
	 * drops a flag. `positionals` replaces the arguments with their canonical form.
	 *
	 * @param overrides - Flags to set or, with `undefined`, to drop.
	 * @param positionals - The arguments to use instead of the call's own.
	 * @returns The command, quoted so it stays runnable.
	 * @example
	 * commandWith({ offset: 20 }); // "fgj read issue list --offset 20"
	 */
	commandWith(
		overrides: Record<string, FlagValue | undefined>,
		positionals?: readonly string[],
	): string;
	/**
	 * The exact fgj command line for another verb, for a hint. It keeps this
	 * call's `--repo`, and `--as` when `--as` chose the profile, so the hint
	 * reads the same repository as the same account. A `repo` in `flags`
	 * replaces the call's `--repo`.
	 *
	 * @param words - The risk class, noun, and action, for example `read issue get`.
	 * @param positionals - The arguments.
	 * @param flags - Flags with a value, in order.
	 * @returns The command, quoted so it stays runnable.
	 * @example
	 * commandFor("read issue get", ["5"], { fields: "number" });
	 * // "fgj read issue get 5 --fields number --repo acme/web" after --repo acme/web
	 */
	commandFor(
		words: string,
		positionals: readonly string[],
		flags?: Record<string, string>,
	): string;
}

interface VerbBase<Input> {
	noun: string;
	action: string;
	summary: string;
	/**
	 * Rules for this verb that an agent needs before it calls it. Help shows
	 * them, so the skill holds only rules that span verbs.
	 */
	notes?: readonly string[];
	args: readonly ArgSpec[];
	flags: readonly FlagSpec[];
	fields?: FieldSpec;
	/** The result shape, for example `{changed, issue, id, url}`. */
	output: string;
	examples: readonly string[];
	/**
	 * Checks the arguments, and reads local files such as `--body-file`, with no
	 * network call. Throws a usage error on bad input.
	 */
	prepare(args: ParsedArgs, local: LocalEnv): Input;
	/** The host and repository that the input names itself, for example from an issue URL. */
	remoteOf?(input: Input): Remote | undefined;
}

/** A verb that only reads. It gets a client that sends GET with the read token. */
export interface ReadVerb<Input> extends VerbBase<Input> {
	risk: "read";
	run(input: Input, ctx: VerbContext<ReadApi>): Promise<unknown>;
}

/** A verb that changes state. It gets a client with the write token. */
export interface WriteVerb<Input> extends VerbBase<Input> {
	risk: "write" | "destroy";
	/**
	 * For a destroy verb: what the call does, for the pi dialog, which sees only
	 * the command text. `$1` is the argument, and `arg` is the regex source of
	 * every argument that the verb accepts. For example
	 * `{ now: "Deletes comment $1", plan: "Plans to delete comment $1", arg: "^[1-9]\\d*$" }`.
	 * `values` gives the regex source of the values that a value flag accepts,
	 * by flag name; `$name` in the text is that flag's value, for example
	 * `$style` for `--style`. A call without the flag gets the generic text.
	 */
	effect?: {
		now: string;
		plan: string;
		arg: string;
		values?: Readonly<Record<string, string>>;
	};
	run(input: Input, ctx: VerbContext<WriteApi, WebWriter>): Promise<unknown>;
}

/** Any verb in the manifest. */
export type Verb = ReadVerb<unknown> | WriteVerb<unknown>;

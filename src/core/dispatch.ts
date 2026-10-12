import { type AuditEntry, appendAudit } from "../auth/audit.ts";
import { runAuth } from "../auth/command.ts";
import { pickIdentity, selectProfile } from "../auth/identity.ts";
import { readStore } from "../auth/store.ts";
import { ReadApi, WriteApi } from "../forgejo/client.ts";
import { originUrl, resolveTarget } from "../forgejo/target.ts";
import { WebReader, WebWriter } from "../forgejo/web.ts";
import { consumeApproval } from "../hooks/approval.ts";
import { runHook } from "../hooks/command.ts";
import { runRules } from "../rules/command.ts";
import { runSkill } from "../rules/skill.ts";
import { findVerb } from "../verbs/manifest.ts";
import { waitTimesFrom } from "../verbs/wait.ts";
import { parseArgs, shellQuote } from "./args.ts";
import { EXIT, FgjError } from "./errors.ts";
import {
	authHelp,
	hookHelp,
	nounHelp,
	rulesHelp,
	SKILL_META,
	topHelp,
	verbHelp,
	verbsFor,
} from "./help.ts";
import { toLine } from "./output.ts";
import { createRedactor } from "./redact.ts";
import { createTracer, type Tracer } from "./trace.ts";
import {
	exitCodeOf,
	type FlagValue,
	type ParsedArgs,
	RISKS,
	type Risk,
	type Verb,
} from "./verb.ts";
import { VERSION } from "./version.ts";

/** The process surface that {@link main} uses, so tests can replace it. */
export interface Io {
	cwd: string;
	env: Record<string, string | undefined>;
	stdout(text: string): void;
	stderr(text: string): void;
	/**
	 * Asks a human one question at the terminal. `secret` turns echo off. The CLI
	 * sets this only when stdin and stderr are terminals, so an agent never has it.
	 */
	prompt?(question: string, secret: boolean): Promise<string>;
	/**
	 * Reads all of stdin, for `fgj hook`. The CLI sets this only when stdin is a
	 * pipe, so a call at a terminal never waits for input.
	 */
	readInput?(): Promise<string>;
}

function isRisk(value: string | undefined): value is Risk {
	return RISKS.includes(value as Risk);
}

function commandLine(
	verb: Verb,
	args: ParsedArgs,
	overrides: Record<string, FlagValue | undefined>,
	positionals: readonly string[] = args.positionals,
): string {
	const flags = { ...args.flags, ...overrides };
	const parts = ["fgj", verb.risk, verb.noun, verb.action, ...positionals];
	for (const spec of verb.flags) {
		const value = flags[spec.name];
		if (value === undefined) continue;
		if (value === true) parts.push(`--${spec.name}`);
		else if (Array.isArray(value)) {
			for (const v of value) {
				if (v.startsWith("-")) parts.push(`--${spec.name}=${v}`);
				else parts.push(`--${spec.name}`, v);
			}
		}
		// A value that starts with - would read as a flag, so keep it attached.
		else if (String(value).startsWith("-"))
			parts.push(`--${spec.name}=${value}`);
		else parts.push(`--${spec.name}`, String(value));
	}
	// Repeat --as only when the command chose the profile, never an env binding.
	if (args.as !== undefined) parts.push("--as", args.as);
	return parts.map(shellQuote).join(" ");
}

/**
 * Runs one fgj command: it checks the risk class, parses and checks the
 * arguments with no network call, resolves the target and token, and runs the verb.
 *
 * @param argv - The argv after `fgj`, for example `["read", "comment", "list", "157"]`.
 * @param io - The working directory, env, and output sinks.
 * @returns The exit code. Results go to `io.stdout`; errors go to `io.stderr` as JSON.
 * @example
 * const code = await main(["read", "comment", "list", "157"], io);
 */
export async function main(argv: readonly string[], io: Io): Promise<number> {
	// Every byte leaves through the redactor, so a server error that echoes a
	// token cannot print it. Env tokens are registered before any output.
	const redact = createRedactor();
	redact.add(io.env.FGJ_READ_TOKEN);
	redact.add(io.env.FGJ_WRITE_TOKEN);
	const safe: Io = {
		...io,
		stdout: (text) => io.stdout(redact.apply(text)),
		stderr: (text) => io.stderr(redact.apply(text)),
	};
	const trace = createTracer(io.env, safe.stderr, redact);
	trace.emit({ ev: "argv", argv, cwd: io.cwd });
	const ctx: RunContext = {
		argv,
		addSecret: redact.add,
		holdsSecret: redact.contains,
		// argv can hold free text such as --title, so a token there is redacted too.
		audit: (entry) =>
			appendAudit(io.env, { ...entry, argv: entry.argv.map(redact.apply) }),
	};
	const code = await runCommand(safe, trace, ctx).catch(
		async (err: unknown) => {
			const error =
				err instanceof FgjError
					? err
					: new FgjError("api", `Internal error: ${String(err)}`, "fgj help");
			trace.emit({ ev: "error", code: error.code, message: error.message });
			const out = error.toJSON();
			safe.stderr(
				toLine(ctx.actor ? { error: { ...out.error, as: ctx.actor.as } } : out),
			);
			if (ctx.actor && ctx.writes) {
				await ctx.audit({
					...ctx.actor,
					argv,
					cwd: io.cwd,
					error: error.code,
				});
			} else if (
				!ctx.actor &&
				(ctx.unapproved ||
					(ctx.attempted !== undefined &&
						(error.code === "identity_mismatch" || error.code === "auth")))
			) {
				// Log every refused --as, reads included, and every destroy that pi ran
				// with no approval: they are the key misuse signals.
				await ctx.audit({
					as: io.env.FGJ_PROFILE ?? "",
					user: undefined,
					...(ctx.attempted ? { attempted: ctx.attempted } : {}),
					argv,
					cwd: io.cwd,
					error: error.code,
				});
			}
			return error.exitCode;
		},
	);
	trace.emit({ ev: "exit", code });
	return code;
}

function unknownVerb(noun: string | undefined, action: string | undefined) {
	const known = noun !== undefined && verbsFor(noun).startsWith("Verbs");
	return new FgjError(
		"usage",
		`Unknown verb "${[noun, action].filter(Boolean).join(" ")}". ${verbsFor(noun)}`,
		known ? `fgj help ${noun}` : "fgj help",
	);
}

function help(words: readonly string[]): Record<string, unknown> {
	// Agents often write the risk class as in a call: help reads nothing, so
	// fgj drops it, and the result's cmd shows the verb's real class.
	const [noun, action] = isRisk(words[0]) ? words.slice(1) : words;
	if (noun === undefined) return topHelp();
	if (noun === "auth") return authHelp();
	if (noun === "rules") return rulesHelp();
	if (noun === "hook") return hookHelp();
	if (noun === "skill") return { commands: SKILL_META };
	if (action === undefined) return nounHelp(noun);
	const verb = findVerb(noun, action);
	if (!verb) throw unknownVerb(noun, action);
	return verbHelp(verb);
}

/** What one run learns as it goes, so errors and the audit log can name the actor. */
interface RunContext {
	argv: readonly string[];
	addSecret: (value: string) => void;
	holdsSecret: (text: string) => boolean;
	/** Appends one audit line, with every known token in argv redacted. */
	audit: (entry: AuditEntry) => Promise<void>;
	actor?: { as: string; user: string | undefined; host: string; repo: string };
	/** True for write and destroy verbs: their runs go to the audit log. */
	writes?: boolean;
	/** The profile that `--as` asked for, kept so a refused switch can be logged. */
	attempted?: string;
	/** True when pi ran a destroy with no approval: the refusal goes to the audit log. */
	unapproved?: boolean;
}

async function runCommand(
	io: Io,
	trace: Tracer,
	ctx: RunContext,
): Promise<number> {
	const { argv, addSecret } = ctx;
	const [risk, noun, action, ...rest] = argv;
	if (
		risk === undefined ||
		risk === "help" ||
		risk === "--help" ||
		risk === "-h"
	) {
		io.stdout(toLine(help(argv.slice(1).filter((w) => w !== "--json"))));
		return EXIT.ok;
	}
	if (risk === "--version" || risk === "version") {
		io.stdout(toLine({ version: VERSION }));
		return EXIT.ok;
	}
	if (risk === "auth") {
		if (argv.includes("--help") || argv.includes("-h")) {
			io.stdout(toLine(help(["auth"])));
			return EXIT.ok;
		}
		// The subcommand comes right after auth, so a harness gate that matches
		// "fgj auth default" sees every call that can change the default.
		const first = argv[1];
		if (
			first?.startsWith("-") &&
			first !== "--profile" &&
			!first.startsWith("--profile=")
		) {
			throw new FgjError(
				"usage",
				`Put ${first} after the subcommand, for example fgj auth status ${first}.`,
				"fgj help auth",
			);
		}
		const words = argv.slice(1).filter((w) => w !== "--json");
		return runAuth(words, io, trace, addSecret);
	}
	if (risk === "hook") {
		if (argv.includes("--help")) {
			io.stdout(toLine(help(["hook"])));
			return EXIT.ok;
		}
		return runHook(
			argv.slice(1).filter((w) => w !== "--json"),
			io,
		);
	}
	if (risk === "skill") {
		if (argv.includes("--help")) {
			io.stdout(toLine(help(["skill"])));
			return EXIT.ok;
		}
		return runSkill(
			argv.slice(1).filter((w) => w !== "--json"),
			io,
		);
	}
	if (risk === "rules") {
		if (argv.includes("--help")) {
			io.stdout(toLine(help(["rules"])));
			return EXIT.ok;
		}
		return runRules(
			argv.slice(1).filter((w) => w !== "--json"),
			io,
		);
	}
	if (!isRisk(risk)) {
		throw new FgjError(
			"usage",
			`The first argument must be read, write, or destroy, got "${risk ?? ""}".`,
			"fgj help",
		);
	}
	const verb = noun && action ? findVerb(noun, action) : undefined;
	if (!verb) {
		throw unknownVerb(noun, action);
	}
	if (rest.includes("--help")) {
		io.stdout(toLine(verbHelp(verb)));
		return EXIT.ok;
	}
	if (verb.risk !== risk) {
		// Fail before parsing or any network call: the harness approved `risk`, not `verb.risk`.
		throw new FgjError(
			"risk_mismatch",
			`${noun} ${action} is a ${verb.risk} verb, but the command says ${risk}.`,
			["fgj", verb.risk, verb.noun, verb.action, ...rest]
				.map(shellQuote)
				.join(" "),
		);
	}
	const args = parseArgs(rest, verb);
	if (args.flags.fields === true && verb.fields) {
		io.stdout(
			toLine({ fields: verb.fields.all, default: verb.fields.default }),
		);
		return EXIT.ok;
	}
	const input = verb.prepare(args, { cwd: io.cwd, home: io.env.HOME });
	// Every stored token is a secret before any refusal can reach the audit log.
	const store = await readStore(io.env);
	for (const profile of Object.values(store.profiles)) {
		addSecret(profile.read);
		addSecret(profile.write);
		if (profile.web) addSecret(profile.web.value);
	}
	if (args.as !== undefined) ctx.attempted = args.as;
	// pi runs any command that its extensions pass, so in pi a destroy needs the
	// one-time approval that the fgj pi adapter hands to the approved call. The
	// check comes after the argument checks, so a typo does not use it up.
	if (
		verb.risk === "destroy" &&
		io.env.PI_SESSION_ID &&
		!consumeApproval(io.env, Date.now())
	) {
		ctx.unapproved = true;
		throw new FgjError(
			"auth",
			"In pi, fgj destroy runs only after a human approves this call in the fgj gate. Run the destroy command alone and plain, so the gate can ask.",
			`fgj help ${verb.noun} ${verb.action}`,
		);
	}
	const helpHint = `fgj help ${verb.noun} ${verb.action}`;
	const selected = selectProfile(store, io.env.FGJ_PROFILE, args.as);
	const hosts = [...new Set(Object.values(store.profiles).map((p) => p.host))];
	const repoFlag = args.flags.repo;
	const target = resolveTarget({
		origin: originUrl(io.cwd),
		urlRemote: verb.remoteOf?.(input),
		repoFlag: repoFlag === undefined ? undefined : String(repoFlag),
		storedHosts: selected ? [selected.host] : hosts,
		knownHosts: hosts,
		envUrl: io.env.FGJ_URL,
		helpHint,
	});
	trace.emit({ ev: "target", ...target });
	const identity = pickIdentity(store, selected, target.baseUrl, io.env);
	ctx.actor = {
		as: identity.as,
		user: identity.user,
		host: target.baseUrl,
		repo: `${target.owner}/${target.name}`,
	};
	ctx.writes = verb.risk !== "read";
	const kind = verb.risk === "read" ? "read" : "write";
	const token = identity[kind];
	if (!token) {
		throw new FgjError(
			"auth",
			`The identity ${identity.as} has no ${kind} token for ${target.baseUrl}.`,
			"fgj auth status",
		);
	}
	trace.emit({
		ev: "token",
		kind,
		as: identity.as,
		source: identity.as === "env" ? "env" : "file",
	});
	// Tests set shorter wait times; fgj clamps them.
	const times = waitTimesFrom(io.env.FGJ_WAIT_TIMES);
	const waitTimes = times ? { waitTimes: times } : {};
	const commandWith = (
		overrides: Record<string, FlagValue | undefined>,
		positionals?: readonly string[],
	) => commandLine(verb, args, overrides, positionals);
	const commandFor = (
		words: string,
		positionals: readonly string[],
		flags: Record<string, string> = {},
	) => {
		const repo = args.flags.repo;
		const parts = [
			"fgj",
			...words.split(" "),
			...positionals,
			...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v]),
			// A --repo that the hint names itself replaces the call's own.
			...(repo === undefined || "repo" in flags
				? []
				: ["--repo", String(repo)]),
			...(args.as === undefined ? [] : ["--as", args.as]),
		];
		return parts.map(shellQuote).join(" ");
	};
	let reader: WebReader | undefined;
	const web = () => {
		if (!identity.web) {
			throw identity.as === "env"
				? new FgjError(
						"auth",
						"This verb needs a profile with a web login, and the env tokens have none. A human must run fgj auth, then fgj auth web.",
						"fgj auth status",
					)
				: new FgjError(
						"auth",
						`The profile ${identity.as} has no web login, and this verb needs one. A human must run fgj auth web --profile ${identity.as}.`,
						`fgj auth web --profile ${identity.as}`,
					);
		}
		// A read verb gets a client that cannot POST, not only a narrower type.
		const Client = verb.risk === "read" ? WebReader : WebWriter;
		reader ??= new Client(
			target.baseUrl,
			identity.web,
			identity.as,
			trace,
			addSecret,
		);
		return reader;
	};
	const writer = () => {
		const client = web();
		if (!(client instanceof WebWriter)) {
			throw new FgjError(
				"api",
				"A read verb asked for a web writer.",
				"fgj help",
			);
		}
		return client;
	};
	const result = await (verb.risk === "read"
		? verb.run(input, {
				target,
				api: new ReadApi(target.baseUrl, token, trace),
				web,
				commandWith,
				commandFor,
				...waitTimes,
			})
		: verb.run(input, {
				target,
				api: new WriteApi(target.baseUrl, token, trace, ctx.holdsSecret),
				web: writer,
				commandWith,
				commandFor,
				...waitTimes,
			})
	).catch((err: unknown) => {
		// The client cannot know the verb, so it gives the generic help; name the verb's.
		if (err instanceof FgjError && err.hint === "fgj help") {
			throw new FgjError(err.code, err.message, helpHint);
		}
		throw err;
	});
	const line = toLine({ ...(result as object), as: identity.as });
	trace.emit({ ev: "out", chars: line.length });
	io.stdout(line);
	if (ctx.writes) {
		const r = result as Record<string, unknown>;
		const summary: Record<string, unknown> = Object.fromEntries(
			["changed", "dry_run", "id", "number", "issue", "pr", "on"]
				.filter((k) => r[k] !== undefined)
				.map((k) => [k, r[k]]),
		);
		// A many-item write logs each item's outcome, with only the error code.
		if (Array.isArray(r.items)) {
			summary.items = (r.items as Record<string, unknown>[]).map((i) => {
				const error = i.error as { code?: string } | undefined;
				const key =
					"on" in i
						? { on: i.on }
						: "pr" in i
							? { pr: i.pr }
							: { number: i.number };
				return error
					? { ...key, error: error.code }
					: { ...key, changed: i.changed };
			});
		}
		await ctx.audit({
			...ctx.actor,
			argv,
			cwd: io.cwd,
			result: summary,
		});
	}
	return exitCodeOf(result);
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROFILE_NAME_SHAPE } from "../auth/identity.ts";
import type { Io } from "../core/dispatch.ts";
import { EXIT, FgjError } from "../core/errors.ts";
import { toLine } from "../core/output.ts";
import { approvalDir } from "../hooks/approval.ts";
import {
	claudeEntries,
	claudeFgjPart,
	claudeSettings,
	codexRules,
	piExtension,
} from "./generate.ts";
import {
	HARNESSES,
	type Harness,
	harnessArg,
	harnessDir,
	installWithConsent,
	readIfExists,
} from "./install.ts";

// The build selects the callback form without relying on the runtime's file name.
declare const FGJ_STANDALONE: boolean | undefined;

type Env = Record<string, string | undefined>;

const PROFILE = new RegExp(PROFILE_NAME_SHAPE);

/** Where fgj writes each harness's rules. */
function fileFor(harness: Harness, env: Env): string {
	const dir = harnessDir(harness, env);
	if (harness === "codex") return join(dir, "rules", "fgj.rules");
	if (harness === "claude") return join(dir, "settings.json");
	return join(dir, "extensions", "fgj-gate.ts");
}

/**
 * The command that runs this fgj, for an adapter that calls fgj back: the
 * compiled binary itself, or Bun with isolated startup flags and the script path.
 */
function fgjCommand(): string[] {
	const runtime = process.execPath;
	const standalone = typeof FGJ_STANDALONE === "boolean" && FGJ_STANDALONE;
	return !standalone && process.argv[1]
		? [runtime, "--no-env-file", "--config=/dev/null", resolve(process.argv[1])]
		: [runtime];
}

/** The whole new file text that an install writes. */
function desired(
	harness: Harness,
	existing: string | undefined,
	env: Env,
): string {
	if (harness === "codex") return codexRules();
	if (harness === "claude") return claudeSettings(existing);
	return piExtension({ fgj: fgjCommand(), approvals: approvalDir(env) });
}

/** A pi role name: a lane agent's name, such as `team.qa`. */
const ROLE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Where the role form of the pi adapter goes: outside pi's auto-load folder. */
function roleFile(env: Env, role: string): string {
	return join(harnessDir("pi", env), "fgj-roles", `${role}.ts`);
}

/** The role form of the pi adapter, for one role's profile. */
function roleAdapter(profile: string, env: Env): string {
	return piExtension({
		fgj: fgjCommand(),
		approvals: approvalDir(env),
		profile,
	});
}

/** Reads `--role <role>=<profile>` from the words after the harness. */
function roleArg(
	rest: readonly string[],
): { role: string; profile: string } | undefined {
	if (rest.length === 0) return undefined;
	const [flag, value] =
		rest[0]?.startsWith("--role=") && rest.length === 1
			? ["--role", rest[0].slice(7)]
			: rest.length === 2
				? rest
				: [];
	const match = flag === "--role" ? /^([^=]+)=(.+)$/.exec(value ?? "") : null;
	const role = match?.[1];
	const profile = match?.[2];
	if (!role || !profile || !ROLE.test(role) || !PROFILE.test(profile)) {
		throw new FgjError(
			"usage",
			`Expected --role <role>=<profile>, such as --role team.qa=team-qa, got "${rest.join(" ")}".`,
			"fgj help rules",
		);
	}
	return { role, profile };
}

/** The installed role files and their state, for `fgj rules status`. */
function roleStates(
	env: Env,
): { role: string; profile: string | null; file: string; state: string }[] {
	const dir = join(harnessDir("pi", env), "fgj-roles");
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter(
			(entry) =>
				(entry.isFile() || entry.isSymbolicLink()) &&
				entry.name.endsWith(".ts"),
		)
		.map((entry) => entry.name)
		.sort()
		.map((name) => {
			const file = join(dir, name);
			let text = "";
			try {
				text = readFileSync(file, "utf8");
			} catch {
				// An unreadable file reads as outdated.
			}
			const profile =
				/^const PROFILE: string \| undefined = "([^"]+)";$/m.exec(text)?.[1] ??
				null;
			const state =
				profile && text === roleAdapter(profile, env) ? "current" : "outdated";
			return { role: name.slice(0, -3), profile, file, state };
		});
}

/** The part a human or an agent may see. For Claude, only fgj's entries. */
function visible(harness: Harness, text: string | undefined): string {
	if (harness !== "claude") return text ?? "";
	return `${JSON.stringify(claudeFgjPart(text), null, 2)}\n`;
}

function state(harness: Harness, text: string | undefined, env: Env): string {
	if (harness === "claude") {
		const part = claudeFgjPart(text);
		if (part.allow.length === 0 && part.ask.length === 0) return "missing";
		const want = claudeEntries();
		const same =
			JSON.stringify(part.allow) === JSON.stringify(want.allow) &&
			JSON.stringify(part.ask) === JSON.stringify(want.ask);
		return same ? "current" : "outdated";
	}
	if (text === undefined) return "missing";
	return text === desired(harness, text, env) ? "current" : "outdated";
}

/**
 * Runs `fgj rules`: `show <harness>` prints what fgj would install, `status`
 * compares each harness with fgj's rules, and `install <harness>` shows a diff
 * and writes after a human says yes.
 *
 * @param words - The argv after `rules`.
 * @param io - The process surface. `io.prompt` must exist for an install.
 * @returns The exit code.
 * @throws {FgjError} A usage error for a bad harness or a missing terminal.
 * @example
 * await runRules(["status"], io);
 */
export async function runRules(
	words: readonly string[],
	io: Io,
): Promise<number> {
	const [sub, raw] = words;
	if (sub === "status") {
		const harnesses = await Promise.all(
			HARNESSES.map(async (harness) => {
				const file = fileFor(harness, io.env);
				const roles = harness === "pi" ? roleStates(io.env) : [];
				return {
					harness,
					file,
					state: state(harness, await readIfExists(file), io.env),
					...(roles.length > 0 ? { roles } : {}),
				};
			}),
		);
		io.stdout(toLine({ harnesses }));
		return EXIT.ok;
	}
	if (sub === "show") {
		const harness = harnessArg(raw, "fgj help rules");
		const bound = harness === "pi" ? roleArg(words.slice(2)) : undefined;
		if (!bound && words.length > 2) {
			throw new FgjError(
				"usage",
				`fgj rules show ${harness} takes no more words, got "${words.slice(2).join(" ")}". Only pi takes --role.`,
				"fgj help rules",
			);
		}
		if (bound) {
			const file = roleFile(io.env, bound.role);
			const content = roleAdapter(bound.profile, io.env);
			io.stdout(toLine({ harness, role: bound.role, file, content }));
			return EXIT.ok;
		}
		const file = fileFor(harness, io.env);
		const content = visible(
			harness,
			desired(harness, await readIfExists(file), io.env),
		);
		io.stdout(toLine({ harness, file, content }));
		return EXIT.ok;
	}
	if (sub !== "install") {
		throw new FgjError(
			"usage",
			`Expected show, status, or install. Got "${sub ?? ""}".`,
			"fgj help rules",
		);
	}
	const harness = harnessArg(raw, "fgj help rules");
	const bound = harness === "pi" ? roleArg(words.slice(2)) : undefined;
	if (bound) {
		const file = roleFile(io.env, bound.role);
		return installWithConsent(
			io,
			{
				harness,
				file,
				before: await readIfExists(file),
				after: roleAdapter(bound.profile, io.env),
				shown: (text) => text ?? "",
			},
			"fgj rules install",
		);
	}
	if (words.length > 2) {
		throw new FgjError(
			"usage",
			`fgj rules install ${harness} takes no more words, got "${words.slice(2).join(" ")}". Only pi takes --role.`,
			"fgj help rules",
		);
	}
	const file = fileFor(harness, io.env);
	const before = await readIfExists(file);
	return installWithConsent(
		io,
		{
			harness,
			file,
			before,
			after: desired(harness, before, io.env),
			shown: (text) => visible(harness, text),
			backup: harness === "claude",
		},
		"fgj rules install",
	);
}

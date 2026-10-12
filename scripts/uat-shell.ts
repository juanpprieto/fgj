#!/usr/bin/env bun
/**
 * Runs one command, such as a harness, against the fgj build of the current
 * commit. It builds `dist/fgj`, puts `dist/` first on the child's PATH, checks
 * that the fgj the child resolves names HEAD, then runs the command in `--cwd`
 * and returns its exit code. It replaces no shared fgj, rules, skill, or token.
 *
 * - It refuses a work tree with changes: a run record must name one commit.
 * - `--cwd DIR` is required: `bun run` starts scripts in the checkout, where a
 *   call without `--repo` would act on this repository.
 * - `--profile NAME` sets FGJ_PROFILE in the child only.
 * - Its own failures exit 125, and a command that it cannot find exits 127, as
 *   with `env`. Every other code is the command's own.
 *
 * Usage: bun scripts/uat-shell.ts --cwd DIR [--profile NAME] -- <command...>
 */
import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROFILE_NAME_SHAPE } from "../src/auth/identity.ts";
import { originUrl, parseRemote } from "../src/forgejo/target.ts";

const ROOT = resolve(import.meta.dir, "..");
const USAGE =
	"Usage: bun run uat:shell --cwd DIR [--profile NAME] -- <command...>";
/** The exit code of a failure in this script, as with `env`. */
const FAILED = 125;
/** The exit code when the command is not on the child's PATH. */
const NOT_FOUND = 127;

/** The parsed arguments of `uat:shell`. */
export interface UatArgs {
	/** The absolute directory to run the command in, outside the checkout. */
	cwd: string;
	/** The fgj profile for FGJ_PROFILE in the child, when given. */
	profile?: string;
	/** The command to run, and its arguments. */
	command: string[];
}

/** True when `path` is `root` or a path inside it. A folder named `..x` is inside. */
function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Tells whether two git remote URLs name the same Forgejo repository, so a
 * clone or worktree of fgj elsewhere counts as this repository.
 *
 * @param a - A remote URL, or null when there is none.
 * @param b - Another remote URL, or null when there is none.
 * @returns True when both name the same host, owner, and name, in any letter case.
 * @example
 * sameRepo("git@git.example.com:a/fgj.git", "https://git.example.com/a/fgj"); // true
 */
export function sameRepo(a: string | null, b: string | null): boolean {
	const x = a ? parseRemote(a) : null;
	const y = b ? parseRemote(b) : null;
	if (!x || !y) return false;
	const key = (r: typeof x) =>
		`${r.baseUrl}/${r.owner}/${r.name}`.toLowerCase();
	return key(x) === key(y);
}

/**
 * Reads the `uat:shell` arguments: `--cwd DIR`, an optional `--profile NAME`,
 * an optional `--`, then the command. `bun run` drops the first `--`, so the
 * command can also start at the first argument that is not a flag.
 *
 * @param argv - The arguments after the script name.
 * @param root - The checkout that `--cwd` must stay out of.
 * @returns The directory, the profile when given, and the command.
 * @throws {Error} When the command or `--cwd` is missing, `--cwd` is relative
 *   or inside the checkout, a flag is unknown or repeated, or the profile name
 *   has the wrong shape.
 * @example
 * uatArgs(["--cwd", "/tmp/uat", "--profile", "agent-codex", "--", "codex", "exec", "hi"]);
 * // { cwd: "/tmp/uat", profile: "agent-codex", command: ["codex", "exec", "hi"] }
 */
export function uatArgs(argv: readonly string[], root = ROOT): UatArgs {
	const flags: Record<string, string> = {};
	let i = 0;
	for (; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--") {
			i++;
			break;
		}
		if (!arg.startsWith("-")) break;
		const name = arg.slice(2);
		if (!["cwd", "profile"].includes(name) || name in flags) {
			throw new Error(`Unknown or repeated flag ${arg}. ${USAGE}`);
		}
		flags[name] = argv[++i] ?? "";
	}
	const command = argv.slice(i);
	if (command.length === 0) throw new Error(`Missing the command. ${USAGE}`);
	const cwd = flags.cwd;
	if (cwd === undefined || !isAbsolute(cwd)) {
		throw new Error(
			`--cwd needs an absolute directory, such as a test-owned work folder. ${USAGE}`,
		);
	}
	if (inside(root, cwd)) {
		throw new Error(
			`--cwd ${cwd} is inside the fgj checkout. Use a folder outside it, so a call without --repo cannot act on this repository.`,
		);
	}
	const profile = flags.profile;
	if (profile === undefined) return { cwd, command };
	if (!new RegExp(PROFILE_NAME_SHAPE).test(profile)) {
		throw new Error(
			`--profile needs a profile name: a-z, 0-9, _ and -, starting with a letter or digit. Got "${profile}".`,
		);
	}
	return { cwd, profile, command };
}

/**
 * Builds the child environment from `env`. It removes what `bun run` adds (the
 * checkout's PATH entries and the `npm_*` variables), puts `dist` first on
 * PATH, and sets FGJ_PROFILE only when a profile is given.
 *
 * @param env - The parent environment. It does not change.
 * @param dist - The absolute path of the checkout's `dist` directory.
 * @param root - The checkout, whose other PATH entries the child does not get.
 * @param profile - The profile for FGJ_PROFILE, or undefined to keep the parent's.
 * @returns The new environment.
 * @example
 * childEnv({ PATH: "/r/node_modules/.bin:/bin" }, "/r/dist", "/r", "agent-codex");
 * // { PATH: "/r/dist:/bin", FGJ_PROFILE: "agent-codex" }
 */
export function childEnv(
	env: Readonly<Record<string, string | undefined>>,
	dist: string,
	root: string,
	profile?: string,
): Record<string, string | undefined> {
	const kept = Object.fromEntries(
		Object.entries(env).filter(([key]) => !/^npm_/i.test(key)),
	);
	const path = (env.PATH ?? "")
		.split(delimiter)
		.filter((p) => p !== "" && p !== root && !p.startsWith(root + sep));
	return {
		...kept,
		PATH: [dist, ...path].join(delimiter),
		...(profile === undefined ? {} : { FGJ_PROFILE: profile }),
	};
}

/**
 * Tells whether `git status --porcelain` output shows a changed work tree.
 *
 * @param porcelain - The output of `git status --porcelain`.
 * @returns True when any file is changed, staged, or untracked.
 * @example
 * treeChanged(" M README.md\n"); // true
 */
export function treeChanged(porcelain: string): boolean {
	return porcelain.trim() !== "";
}

/**
 * Checks that the version of the fgj that the child resolves names HEAD and
 * no changed tree.
 *
 * @param version - The `version` from `fgj --version`, or undefined when it did not answer.
 * @param head - The short SHA of HEAD.
 * @returns A message that says what is wrong, or undefined when the version is right.
 * @example
 * versionProblem("0.1.0+9ba7ddb", "9ba7ddb"); // undefined
 */
export function versionProblem(
	version: string | undefined,
	head: string,
): string | undefined {
	if (version === undefined) return "The child's fgj gave no version.";
	if (version.endsWith("-dirty")) {
		return `The child's fgj is ${version}, a build of a changed tree. Commit first.`;
	}
	if (!version.endsWith(`+${head}`)) {
		return `The child's fgj is ${version}, but HEAD is ${head}.`;
	}
	return undefined;
}

function fail(message: string, code = FAILED): never {
	console.error(JSON.stringify({ error: message }));
	process.exit(code);
}

function git(...cmd: string[]): string {
	return Bun.spawnSync(["git", ...cmd], { cwd: ROOT })
		.stdout.toString()
		.trim();
}

if (import.meta.main) {
	let args: UatArgs;
	try {
		args = uatArgs(process.argv.slice(2));
	} catch (err) {
		fail((err as Error).message);
	}
	let isDir = false;
	try {
		isDir = statSync(args.cwd).isDirectory();
	} catch {
		// Reported below.
	}
	if (!isDir) fail(`--cwd ${args.cwd} is not a directory.`);
	// A symlink must not lead back into the checkout either.
	if (inside(realpathSync(ROOT), realpathSync(args.cwd))) {
		fail(
			`--cwd ${args.cwd} leads into the fgj checkout. Use a folder outside it.`,
		);
	}
	// Another clone or worktree of fgj has the same origin, so it is refused too.
	if (sameRepo(originUrl(args.cwd), originUrl(ROOT))) {
		fail(
			`--cwd ${args.cwd} is in a clone of the fgj repository, so a call without --repo would act on it. Use a test-owned folder.`,
		);
	}
	if (treeChanged(git("status", "--porcelain"))) {
		fail(
			"The work tree has changes. Commit first: a run must name one commit.",
		);
	}
	const build = Bun.spawnSync(["bun", join(ROOT, "scripts", "build.ts")], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (build.exitCode !== 0) fail(`build failed: ${build.stderr.toString()}`);
	const dist = join(ROOT, "dist");
	const env = childEnv(process.env, dist, ROOT, args.profile);
	// Resolve each program with the child's PATH, not this process's.
	const fgj = Bun.which("fgj", { PATH: env.PATH ?? "" });
	if (fgj !== join(dist, "fgj")) {
		fail(`The child would run ${fgj ?? "no fgj"}, not ${join(dist, "fgj")}.`);
	}
	const probe = Bun.spawnSync([fgj, "--version"], { env, stdout: "pipe" });
	let version: string | undefined;
	try {
		version = (JSON.parse(probe.stdout.toString()) as { version?: string })
			.version;
	} catch {
		version = undefined;
	}
	const problem = versionProblem(version, git("rev-parse", "--short", "HEAD"));
	if (problem) fail(problem);
	const [program = "", ...rest] = args.command;
	// A path such as ./run.sh is relative to --cwd, as in a shell there.
	const lookup = program.includes("/") ? resolve(args.cwd, program) : program;
	const bin = Bun.which(lookup, { PATH: env.PATH ?? "" });
	if (!bin)
		fail(`Command not found on the child's PATH: ${program}`, NOT_FOUND);
	console.error(
		JSON.stringify({
			uat_shell: {
				fgj,
				version,
				cwd: args.cwd,
				...(args.profile ? { profile: args.profile } : {}),
			},
		}),
	);
	const child = Bun.spawn([bin, ...rest], {
		cwd: args.cwd,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	// Pass a stop on to the command, so a killed run leaves no harness behind.
	for (const signal of ["SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => child.kill(signal));
	}
	// A terminal sends Ctrl+C to the command already; a second one could end
	// a harness session, so this process only waits.
	process.on("SIGINT", () => {});
	process.exit(await child.exited);
}

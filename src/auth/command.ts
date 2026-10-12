import type { Io } from "../core/dispatch.ts";
import { EXIT, FgjError } from "../core/errors.ts";
import { toLine } from "../core/output.ts";
import type { Tracer } from "../core/trace.ts";
import { originUrl, parseRemote } from "../forgejo/target.ts";
import { checkWebLogin, signIn } from "../forgejo/web.ts";
import { pickIdentity, profileName, selectProfile } from "./identity.ts";
import {
	hostsFile,
	readStore,
	removeProfile,
	type Store,
	saveProfile,
	saveWebLogin,
	setBoundOnly,
	setDefault,
	type TokenKind,
} from "./store.ts";
import { SCOPES, verifyToken } from "./verify.ts";

/** How many times `fgj auth` asks for one token before it gives up. */
const ATTEMPTS = 3;

/** Asks a `[y/N]` question. Only `y` or `yes` counts as yes. */
async function confirm(
	prompt: NonNullable<Io["prompt"]>,
	question: string,
): Promise<boolean> {
	const answer = (await prompt(question, false)).trim().toLowerCase();
	return answer === "y" || answer === "yes";
}

/** The `[y/N]` question that marks a profile as the default for its host. */
function defaultQuestion(
	profile: string,
	user: string,
	host: string,
	current: string | undefined,
	named: boolean,
): string {
	const who = named ? `${profile} (${user})` : profile;
	const instead = current ? `, instead of ${current}` : "";
	return `Make ${who} the default for ${host}${instead}? Calls that select no profile will act as ${user}. [y/N] `;
}

function normalizeUrl(raw: string): string {
	if (!/^https?:\/\/[^\s/]+/.test(raw)) {
		throw new FgjError(
			"usage",
			`Expected an http(s) URL, for example https://git.example.com, got "${raw}".`,
			"fgj help auth",
		);
	}
	return raw.replace(/\/+$/, "");
}

/**
 * Checks that the URL is a Forgejo server.
 *
 * @returns True when the server hid its version behind a sign-in error.
 */
async function checkForgejo(baseUrl: string): Promise<boolean> {
	let forgejo = false;
	let hidden = false;
	try {
		const res = await fetch(`${baseUrl}/api/v1/version`);
		const body = (await res.json().catch(() => undefined)) as
			| { version?: unknown; message?: unknown }
			| undefined;
		// A server that needs sign-in for every API call (REQUIRE_SIGNIN_VIEW)
		// answers 401 or 403 with a JSON message. The token check proves the rest.
		hidden =
			(res.status === 401 || res.status === 403) &&
			typeof body?.message === "string";
		forgejo = (res.ok && typeof body?.version === "string") || hidden;
	} catch {
		forgejo = false;
	}
	if (!forgejo) {
		throw new FgjError(
			"api",
			`${baseUrl} is not a reachable Forgejo server: GET /api/v1/version gave neither a version nor a sign-in error.`,
			"fgj help auth",
		);
	}
	return hidden;
}

function instructions(baseUrl: string, file: string): string {
	return [
		`fgj stores two tokens for ${baseUrl}.`,
		`Create them at ${baseUrl}/user/settings/applications (Access tokens).`,
		"Best: use a dedicated bot account that can reach only the repositories agents need.",
		"",
		"On that page, set the permission menus as below. Every other category: No access.",
		"If the page asks for repository access, include private repositories.",
		"",
		"1. Read token: issue: Read, repository: Read, user: Read.",
		`   (${SCOPES.read}) fgj sends it on every \`fgj read\` call.`,
		"   It cannot change anything.",
		"2. Write token: issue: Read and write, repository: Read and write, user: Read.",
		`   (${SCOPES.write}) fgj sends it on \`fgj write\` and \`fgj destroy\``,
		"   calls. It can add and edit comments and issues, and create, edit, and",
		"   merge pull requests.",
		"",
		`fgj checks each token's scopes, then saves both to ${file} (mode 0600).`,
		"",
	].join("\n");
}

async function askToken(
	io: Io,
	prompt: NonNullable<Io["prompt"]>,
	baseUrl: string,
	kind: TokenKind,
	trace: Tracer,
	addSecret: (value: string) => void,
	check: (user: string) => void,
	versionHidden: boolean,
): Promise<{ token: string; user: string }> {
	const label = kind === "read" ? "Read" : "Write";
	let last: FgjError | undefined;
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		const token = (
			await prompt(`${label} token (input hidden): `, true)
		).trim();
		if (!token) {
			last = new FgjError("usage", "No token entered.", "fgj help auth");
		} else {
			addSecret(token);
			try {
				const { user } = await verifyToken(
					baseUrl,
					token,
					kind,
					trace,
					versionHidden,
				);
				check(user);
				return { token, user };
			} catch (err) {
				if (!(err instanceof FgjError) || err.code === "api") throw err;
				last = err;
			}
		}
		if (attempt < ATTEMPTS) {
			io.stderr(`${last.message} Try again (${ATTEMPTS - attempt} left).\n`);
		}
	}
	throw last as FgjError;
}

async function login(
	arg: string | undefined,
	requested: string | undefined,
	io: Io,
	trace: Tracer,
	addSecret: (value: string) => void,
): Promise<number> {
	const prompt = io.prompt;
	if (!prompt) {
		throw new FgjError(
			"usage",
			"fgj auth asks a human for two tokens at a terminal, with echo off. An agent cannot run it: ask the human to run fgj auth.",
			"fgj auth status",
		);
	}
	const origin = originUrl(io.cwd);
	const fromOrigin = origin ? parseRemote(origin)?.baseUrl : undefined;
	const baseUrl = normalizeUrl(
		arg ?? fromOrigin ?? (await prompt("Forgejo URL: ", false)).trim(),
	);
	const versionHidden = await checkForgejo(baseUrl);
	const file = hostsFile(io.env);
	io.stderr(instructions(baseUrl, file));
	const read = await askToken(
		io,
		prompt,
		baseUrl,
		"read",
		trace,
		addSecret,
		() => {},
		versionHidden,
	);
	const write = await askToken(
		io,
		prompt,
		baseUrl,
		"write",
		trace,
		addSecret,
		(user) => {
			if (user !== read.user) {
				throw new FgjError(
					"auth",
					`The write token belongs to ${user}, but the read token belongs to ${read.user}. Use two tokens of one user.`,
					"fgj auth status",
				);
			}
		},
		versionHidden,
	);
	const profile = requested ?? profileName(read.user);
	const before = await readStore(io.env);
	const old = Object.hasOwn(before.profiles, profile)
		? before.profiles[profile]
		: undefined;
	if (old && (old.host !== baseUrl || old.user !== read.user)) {
		// Another account or host already uses this name; replacing it silently would
		// move every agent bound to it onto a different account.
		const staysDefault =
			old.host === baseUrl && before.defaults[baseUrl] === profile;
		const note = staysDefault
			? ` It is the default for ${baseUrl}: calls that select no profile will act as ${read.user}.`
			: "";
		const replace = await confirm(
			prompt,
			`Replace profile ${profile} (${old.user} on ${old.host}) with ${read.user} on ${baseUrl}?${note} [y/N] `,
		);
		if (!replace) {
			io.stdout(toLine({ changed: false, profile, declined: true }));
			return EXIT.ok;
		}
	}
	await saveProfile(io.env, profile, {
		host: baseUrl,
		user: read.user,
		read: read.token,
		write: write.token,
	});
	// Only a human marks the default: a call that selects no profile acts as it.
	const current = (await readStore(io.env)).defaults[baseUrl];
	const isDefault =
		current === profile ||
		((await confirm(
			prompt,
			defaultQuestion(profile, read.user, baseUrl, current, false),
		)) &&
			(await setDefault(io.env, profile)));
	io.stdout(
		toLine({
			changed: true,
			profile,
			host: baseUrl,
			user: read.user,
			file,
			...(isDefault ? { default: true } : {}),
		}),
	);
	return EXIT.ok;
}

/**
 * Runs `fgj auth web`: a human signs in once, and fgj keeps only the
 * remember-me cookie, for the board verbs and run rerun.
 */
async function webLogin(
	requested: string | undefined,
	io: Io,
	trace: Tracer,
	addSecret: (value: string) => void,
): Promise<number> {
	const prompt = io.prompt;
	if (!prompt) {
		throw new FgjError(
			"usage",
			"fgj auth web asks a human for the account password at a terminal, with echo off. An agent cannot run it: ask the human to run fgj auth web.",
			"fgj auth status",
		);
	}
	const store = await readStore(io.env);
	const names = Object.keys(store.profiles);
	const profile =
		requested ?? (names.length === 1 ? (names[0] as string) : undefined);
	if (profile === undefined) {
		throw new FgjError(
			"usage",
			`Name the profile to sign in: fgj auth web --profile <name>. Profiles: ${names.join(", ") || "(none)"}.`,
			"fgj auth status",
		);
	}
	const entry = Object.hasOwn(store.profiles, profile)
		? store.profiles[profile]
		: undefined;
	if (!entry) {
		throw new FgjError(
			"auth",
			`No profile "${profile}". A human must run fgj auth --profile ${profile} first, to store its tokens.`,
			"fgj auth status",
		);
	}
	const file = hostsFile(io.env);
	io.stderr(
		[
			`fgj signs in to ${entry.host} as ${entry.user} for profile ${profile}, with remember-me.`,
			"The board verbs and run rerun need it, because Forgejo has no API for them.",
			`fgj keeps only the remember-me cookie, in ${file} (mode 0600). It never stores the password.`,
			"Forgejo accepts the cookie for LOGIN_REMEMBER_DAYS (31 by default), unless the password changes.",
			"",
		].join("\n"),
	);
	const signed = await signIn(
		entry.host,
		entry.user,
		{
			password: () =>
				prompt(`Password for ${entry.user} (input hidden): `, true),
			code: () => prompt("TOTP code (input hidden): ", true),
		},
		trace,
		addSecret,
	);
	if (signed.user.toLowerCase() !== entry.user.toLowerCase()) {
		throw new FgjError(
			"auth",
			`The sign-in is for ${signed.user}, but profile ${profile} is ${entry.user}. fgj stored nothing.`,
			"fgj auth status",
		);
	}
	await saveWebLogin(io.env, profile, signed.login);
	io.stdout(
		toLine({
			changed: true,
			profile,
			user: entry.user,
			web_expires: signed.login.expires,
		}),
	);
	return EXIT.ok;
}

async function markDefault(arg: string | undefined, io: Io): Promise<number> {
	if (!arg) {
		throw new FgjError(
			"usage",
			"Missing the profile name to make the default.",
			"fgj auth status",
		);
	}
	if (!io.prompt) {
		throw new FgjError(
			"usage",
			"fgj auth default chooses the account that agents act as when nothing selects one. A human must run it at a terminal.",
			"fgj auth status",
		);
	}
	const profile = profileName(arg);
	const store = await readStore(io.env);
	const entry = Object.hasOwn(store.profiles, profile)
		? store.profiles[profile]
		: undefined;
	if (!entry) {
		const known = Object.keys(store.profiles).join(", ") || "(none)";
		throw new FgjError(
			"auth",
			`No profile "${profile}". Profiles: ${known}.`,
			"fgj auth status",
		);
	}
	const current = store.defaults[entry.host];
	if (current === profile) {
		io.stdout(toLine({ changed: false, profile, host: entry.host }));
		return EXIT.ok;
	}
	// The terminal check and this keystroke stop a plain agent call. They do not
	// prove a human: the harness rules that ask for this command do.
	const yes = await confirm(
		io.prompt,
		defaultQuestion(profile, entry.user, entry.host, current, true),
	);
	if (!yes) {
		io.stdout(toLine({ changed: false, profile, declined: true }));
		return EXIT.ok;
	}
	const changed = await setDefault(io.env, profile);
	io.stdout(toLine({ changed, profile, host: entry.host }));
	return EXIT.ok;
}

/**
 * Runs `fgj auth bound <profile> [on|off]`: a human marks a profile as bound
 * only, so it acts only through a harness binder's `FGJ_PROFILE`.
 */
async function markBound(
	arg: string | undefined,
	value: string | undefined,
	io: Io,
): Promise<number> {
	if (!arg || (value !== undefined && value !== "on" && value !== "off")) {
		throw new FgjError(
			"usage",
			"Expected fgj auth bound <profile> [on|off].",
			"fgj help auth",
		);
	}
	if (!io.prompt) {
		throw new FgjError(
			"usage",
			"fgj auth bound decides how agents may act as an account. A human must run it at a terminal.",
			"fgj auth status",
		);
	}
	const profile = profileName(arg);
	const on = value !== "off";
	const store = await readStore(io.env);
	const entry = Object.hasOwn(store.profiles, profile)
		? store.profiles[profile]
		: undefined;
	if (!entry) {
		const known = Object.keys(store.profiles).join(", ") || "(none)";
		throw new FgjError(
			"auth",
			`No profile "${profile}". Profiles: ${known}.`,
			"fgj auth status",
		);
	}
	if (Boolean(entry.boundOnly) === on) {
		io.stdout(toLine({ changed: false, profile, bound_only: on }));
		return EXIT.ok;
	}
	const question = on
		? `Make ${profile} (${entry.user} on ${entry.host}) bound only? It then acts only through a harness binder, never as the default or through --as. [y/N] `
		: `Let ${profile} (${entry.user} on ${entry.host}) act as the default and through --as again? [y/N] `;
	// The terminal check and this keystroke stop a plain agent call. They do not
	// prove a human: the harness rules that ask for this command do.
	if (!(await confirm(io.prompt, question))) {
		io.stdout(toLine({ changed: false, profile, declined: true }));
		return EXIT.ok;
	}
	const changed = await setBoundOnly(io.env, profile, on);
	io.stdout(toLine({ changed, profile, bound_only: on }));
	return EXIT.ok;
}

async function liveCheck(baseUrl: string, token: string): Promise<string> {
	try {
		const res = await fetch(`${baseUrl}/api/v1/user`, {
			redirect: "manual",
			headers: { authorization: `token ${token}` },
		});
		return res.ok ? "ok" : `HTTP ${res.status}`;
	} catch {
		return "unreachable";
	}
}

/** Says which identity a call from this directory would use, or why none applies. */
function activeIdentity(
	store: Store,
	env: Record<string, string | undefined>,
	cwd: string,
): Record<string, unknown> {
	try {
		const selected = selectProfile(store, env.FGJ_PROFILE, undefined);
		if (selected) {
			const { name, user, host } = selected;
			return { as: name, user, host, source: "FGJ_PROFILE" };
		}
		const hosts = [
			...new Set(Object.values(store.profiles).map((p) => p.host)),
		];
		const envUrl = env.FGJ_URL?.replace(/\/+$/, "") || undefined;
		const origin = originUrl(cwd);
		const fromOrigin = origin ? parseRemote(origin)?.baseUrl : undefined;
		const host =
			fromOrigin && (hosts.includes(fromOrigin) || fromOrigin === envUrl)
				? fromOrigin
				: hosts.length === 1
					? hosts[0]
					: envUrl;
		if (!host) {
			return {
				error:
					"No host: no known git origin here, no single profile host, and no FGJ_URL.",
			};
		}
		const id = pickIdentity(store, undefined, host, env);
		return {
			as: id.as,
			user: id.user,
			host,
			source: id.as === "env" ? "env" : "the default for the host",
		};
	} catch (err) {
		if (err instanceof FgjError) {
			// A hint back to this command would send the reader in a circle.
			const self = err.hint === "fgj auth status";
			return { error: err.message, ...(self ? {} : { hint: err.hint }) };
		}
		throw err;
	}
}

async function status(
	io: Io,
	trace: Tracer,
	addSecret: (value: string) => void,
): Promise<number> {
	const store = await readStore(io.env);
	const profiles = await Promise.all(
		Object.entries(store.profiles).map(async ([profile, entry]) => {
			addSecret(entry.read);
			addSecret(entry.write);
			if (entry.web) addSecret(entry.web.value);
			const [read, write, web] = await Promise.all([
				liveCheck(entry.host, entry.read),
				liveCheck(entry.host, entry.write),
				entry.web
					? checkWebLogin(entry.host, entry.web, trace)
					: Promise.resolve("none"),
			]);
			return {
				profile,
				host: entry.host,
				user: entry.user,
				read,
				write,
				web,
				...(entry.web ? { web_expires: entry.web.expires } : {}),
				...(store.defaults[entry.host] === profile ? { default: true } : {}),
				...(entry.boundOnly ? { bound_only: true } : {}),
			};
		}),
	);
	const envUrl = io.env.FGJ_URL?.replace(/\/+$/, "");
	io.stdout(
		toLine({
			file: hostsFile(io.env),
			profiles,
			active: activeIdentity(store, io.env, io.cwd),
			...(envUrl
				? {
						env: {
							url: envUrl,
							read: Boolean(io.env.FGJ_READ_TOKEN),
							write: Boolean(io.env.FGJ_WRITE_TOKEN),
						},
					}
				: {}),
			...(profiles.length === 0 && !envUrl
				? {
						action:
							"No profile has tokens. Ask the human to run fgj auth with the Forgejo URL.",
					}
				: {}),
		}),
	);
	return EXIT.ok;
}

/**
 * Runs `fgj auth`: `fgj auth [--profile <name>] [<url>]` stores tokens after a
 * human types them, `fgj auth web [--profile <name>]` stores the web login
 * that the board verbs and run rerun need, `fgj auth status` lists profiles with a live check and the
 * active identity, `fgj auth default <profile>` marks the account that a call
 * with no selection uses, and `fgj auth remove <profile>` forgets one profile.
 * No output ever holds a token.
 *
 * @param words - The argv after `auth`.
 * @param io - The process surface. `io.prompt` must exist for a login.
 * @param trace - The tracer for probe calls.
 * @param addSecret - Registers each token with the redactor before any output.
 * @returns The exit code.
 * @throws {FgjError} A usage, auth, or api error.
 * @example
 * await runAuth(["status"], io, trace, redact.add);
 */
export async function runAuth(
	words: readonly string[],
	io: Io,
	trace: Tracer,
	addSecret: (value: string) => void,
): Promise<number> {
	const [sub, arg] = words;
	if (sub === "status") return status(io, trace, addSecret);
	if (sub === "default") return markDefault(arg, io);
	if (sub === "bound") return markBound(arg, words[2], io);
	if (sub === "remove") {
		if (!arg) {
			throw new FgjError(
				"usage",
				"Missing the profile name to remove.",
				"fgj auth status",
			);
		}
		if (!io.prompt) {
			throw new FgjError(
				"usage",
				"fgj auth remove deletes stored tokens that other agents may use. A human must run it at a terminal.",
				"fgj auth status",
			);
		}
		const profile = profileName(arg);
		const store = await readStore(io.env);
		const entry = Object.hasOwn(store.profiles, profile)
			? store.profiles[profile]
			: undefined;
		if (!entry) {
			io.stdout(toLine({ changed: false, profile }));
			return EXIT.ok;
		}
		// The terminal check and this keystroke stop a plain agent call. They do not
		// prove a human: the harness rules that ask for this command do.
		const yes = await confirm(
			io.prompt,
			`Remove profile ${profile} (${entry.user} on ${entry.host})? [y/N] `,
		);
		if (!yes) {
			io.stdout(toLine({ changed: false, profile, declined: true }));
			return EXIT.ok;
		}
		const changed = await removeProfile(io.env, profile);
		io.stdout(toLine({ changed, profile }));
		return EXIT.ok;
	}
	const rest = [...words];
	let requested: string | undefined;
	const at = rest.findIndex(
		(w) => w === "--profile" || w.startsWith("--profile="),
	);
	if (at >= 0) {
		const word = rest[at] as string;
		const value = word === "--profile" ? rest[at + 1] : word.slice(10);
		if (!value || value.startsWith("--")) {
			throw new FgjError(
				"usage",
				"Flag --profile needs a name.",
				"fgj help auth",
			);
		}
		requested = profileName(value);
		rest.splice(at, word === "--profile" ? 2 : 1);
	}
	if (rest[0] === "web") {
		if (rest.length > 1) {
			throw new FgjError(
				"usage",
				`fgj auth web takes only --profile, got "${rest.slice(1).join(" ")}".`,
				"fgj help auth",
			);
		}
		return webLogin(requested, io, trace, addSecret);
	}
	return login(rest[0], requested, io, trace, addSecret);
}

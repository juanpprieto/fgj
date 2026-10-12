import { chmod, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FgjError } from "../core/errors.ts";
import type { WebLogin } from "../forgejo/web.ts";

/** Which token a call needs. Read verbs use `read`; the others use `write`. */
export type TokenKind = "read" | "write";

/** What `fgj auth` saves for one profile: one Forgejo account on one host. */
export interface ProfileEntry {
	host: string;
	user: string;
	read: string;
	write: string;
	/** The web login for the board verbs and run rerun, from `fgj auth web`. */
	web?: WebLogin;
	/**
	 * Set by a human with `fgj auth bound`: the profile acts only through
	 * `FGJ_PROFILE` from a harness binder, never as the host default or through
	 * `--as`. A lane that loses its binding then has no identity.
	 */
	boundOnly?: true;
}

/** The token file: one entry per profile name, for example `dm` or `qa`. */
export interface Store {
	profiles: Record<string, ProfileEntry>;
	/**
	 * The profile that a human marked as the default, per host. A call that
	 * selects no profile uses it; with no default, the call fails closed.
	 */
	defaults: Record<string, string>;
}

type Env = Record<string, string | undefined>;

/**
 * Finds the token file.
 *
 * @param env - The process env. `XDG_CONFIG_HOME` wins over `HOME`.
 * @returns The absolute path of `fgj/hosts.json`.
 * @example
 * hostsFile({ HOME: "/Users/alice" }); // "/Users/alice/.config/fgj/hosts.json"
 */
export function hostsFile(env: Env): string {
	const base = env.XDG_CONFIG_HOME || join(env.HOME ?? "", ".config");
	return join(base, "fgj", "hosts.json");
}

/**
 * Reads the token file. It refuses a file that other users can read, because the
 * file holds tokens in plain text.
 *
 * @param env - The process env, for {@link hostsFile}.
 * @returns The store, or an empty store when the file does not exist. A file
 *   from before defaults existed reads with no defaults.
 * @throws {FgjError} An auth error when the mode is not private or the JSON is broken.
 * @example
 * Object.keys((await readStore(process.env)).profiles); // ["dm", "qa"]
 */
export async function readStore(env: Env): Promise<Store> {
	const path = hostsFile(env);
	const file = Bun.file(path);
	if (!(await file.exists())) return { profiles: {}, defaults: {} };
	const mode = (await stat(path)).mode & 0o777;
	if (process.platform !== "win32" && (mode & 0o077) !== 0) {
		throw new FgjError(
			"auth",
			`${path} holds tokens and other users can read it (mode ${mode.toString(8)}). Run: chmod 600 ${path}`,
			"fgj auth status",
		);
	}
	try {
		const parsed = (await file.json()) as Partial<Store>;
		return {
			profiles: parsed.profiles ?? {},
			defaults: cleanDefaults(parsed.defaults),
		};
	} catch {
		throw new FgjError(
			"auth",
			`${path} is not valid JSON. A human must run fgj auth again.`,
			"fgj auth status",
		);
	}
}

/** Keeps only the string entries of a `defaults` object; anything else reads as none. */
function cleanDefaults(raw: unknown): Record<string, string> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	return Object.fromEntries(
		Object.entries(raw).filter(
			(e): e is [string, string] => typeof e[1] === "string",
		),
	);
}

/**
 * Writes the token file atomically: a 0600 temp file in a 0700 directory, then a rename.
 *
 * @param env - The process env, for {@link hostsFile}.
 * @param store - The whole store to write.
 * @returns Nothing. The old file stays intact if the write fails.
 * @example
 * await writeStore(process.env, { profiles: {}, defaults: {} });
 */
async function writeStore(env: Env, store: Store): Promise<void> {
	const path = hostsFile(env);
	const dir = dirname(path);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	const temp = join(dir, `.hosts.json.${process.pid}.tmp`);
	await Bun.write(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	await chmod(temp, 0o600);
	await rename(temp, path);
}

/** Drops each default that names the profile, except the one for `keepHost`. */
function dropDefaults(store: Store, name: string, keepHost?: string): void {
	for (const [host, profile] of Object.entries(store.defaults)) {
		if (profile === name && host !== keepHost) delete store.defaults[host];
	}
}

/**
 * Saves one profile. It replaces a profile with the same name and keeps the others.
 * When the profile moves to another host, its default for the old host goes. New
 * tokens for the same account on the same host keep its web login.
 *
 * @param env - The process env, for {@link hostsFile}.
 * @param name - The profile name, for example `dm`.
 * @param entry - The host, the user, and both tokens.
 * @returns Nothing.
 * @example
 * await saveProfile(process.env, "dm", { host: "https://git.example.com", user: "dm-bot", read, write });
 */
export async function saveProfile(
	env: Env,
	name: string,
	entry: ProfileEntry,
): Promise<void> {
	const store = await readStore(env);
	const old = Object.hasOwn(store.profiles, name)
		? store.profiles[name]
		: undefined;
	const same = old?.host === entry.host && old?.user === entry.user;
	const web = same && old?.web ? { web: old.web } : {};
	const bound = same && old?.boundOnly ? { boundOnly: true as const } : {};
	store.profiles[name] = { ...web, ...bound, ...entry };
	dropDefaults(store, name, entry.host);
	await writeStore(env, store);
}

/**
 * Stores the web login of one profile, in place of any older one.
 *
 * @param env - The process env, for {@link hostsFile}.
 * @param name - The profile name. The profile must exist.
 * @param web - The remember-me cookie from `fgj auth web`.
 * @returns Nothing.
 * @throws {FgjError} An auth error when no profile has this name.
 * @example
 * await saveWebLogin(process.env, "dm", { cookie: "persistent", value, expires });
 */
export async function saveWebLogin(
	env: Env,
	name: string,
	web: WebLogin,
): Promise<void> {
	const store = await readStore(env);
	const entry = Object.hasOwn(store.profiles, name)
		? store.profiles[name]
		: undefined;
	if (!entry) {
		throw new FgjError(
			"auth",
			`No profile "${name}". A human must run fgj auth --profile ${name} first.`,
			"fgj auth status",
		);
	}
	entry.web = web;
	await writeStore(env, store);
}

/**
 * Marks one profile as the default for its host. It replaces the host's old
 * default. Only a human sets it, through `fgj auth` or `fgj auth default`.
 *
 * @param env - The process env, for {@link hostsFile}.
 * @param name - The profile name.
 * @returns True when the default changed; false when it was already this profile.
 * @throws {FgjError} An auth error when no profile has this name.
 * @example
 * await setDefault(process.env, "dm"); // true
 */
export async function setDefault(env: Env, name: string): Promise<boolean> {
	const store = await readStore(env);
	const entry = Object.hasOwn(store.profiles, name)
		? store.profiles[name]
		: undefined;
	if (!entry) {
		const known = Object.keys(store.profiles).join(", ") || "(none)";
		throw new FgjError(
			"auth",
			`No profile "${name}". Profiles: ${known}.`,
			"fgj auth status",
		);
	}
	if (store.defaults[entry.host] === name) return false;
	store.defaults[entry.host] = name;
	await writeStore(env, store);
	return true;
}

/**
 * Marks a profile as bound only, or clears the mark.
 *
 * @param env - The process env, for {@link hostsFile}.
 * @param name - The profile name.
 * @param on - True to mark it, false to clear the mark.
 * @returns True when the mark changed.
 * @throws {FgjError} An auth error for an unknown profile.
 * @example
 * await setBoundOnly(process.env, "team-qa", true); // true
 */
export async function setBoundOnly(
	env: Env,
	name: string,
	on: boolean,
): Promise<boolean> {
	const store = await readStore(env);
	const entry = Object.hasOwn(store.profiles, name)
		? store.profiles[name]
		: undefined;
	if (!entry) {
		const known = Object.keys(store.profiles).join(", ") || "(none)";
		throw new FgjError(
			"auth",
			`No profile "${name}". Profiles: ${known}.`,
			"fgj auth status",
		);
	}
	if (Boolean(entry.boundOnly) === on) return false;
	if (on) entry.boundOnly = true;
	else delete entry.boundOnly;
	await writeStore(env, store);
	return true;
}

/**
 * Removes one profile from the token file, and its default mark.
 *
 * @param env - The process env, for {@link hostsFile}.
 * @param name - The profile name.
 * @returns True when the profile was in the file.
 * @example
 * await removeProfile(process.env, "qa"); // true
 */
export async function removeProfile(env: Env, name: string): Promise<boolean> {
	const store = await readStore(env);
	if (!Object.hasOwn(store.profiles, name)) return false;
	delete store.profiles[name];
	dropDefaults(store, name);
	await writeStore(env, store);
	return true;
}

import { FgjError } from "../core/errors.ts";
import type { WebLogin } from "../forgejo/web.ts";
import type { ProfileEntry, Store } from "./store.ts";

/** A profile with its name. */
export interface Profile extends ProfileEntry {
	name: string;
}

/** The account a call acts as: a profile, or the env tokens. */
export interface Identity {
	/** The profile name, or `env` for `FGJ_READ_TOKEN` and `FGJ_WRITE_TOKEN`. */
	as: string;
	/** The Forgejo user, when a profile names it. */
	user: string | undefined;
	read: string | undefined;
	write: string | undefined;
	/** The profile's web login, for the board verbs and run rerun. The env tokens have none. */
	web?: WebLogin;
}

/**
 * The regex source of a valid profile name, after {@link profileName} changes
 * it. The pi gate checks `--as` values against it.
 */
export const PROFILE_NAME_SHAPE = "^[a-z0-9][a-z0-9_-]{0,39}$";
const NAME = new RegExp(PROFILE_NAME_SHAPE);

/**
 * Checks a profile name, or turns a Forgejo login into one: lowercase, with any
 * character outside `a-z 0-9 _ -` changed to `-`.
 *
 * @param raw - A name that a human typed, or a Forgejo login.
 * @returns A valid profile name.
 * @throws {FgjError} A usage error when no valid name results.
 * @example
 * profileName("Example.Agent"); // "example-agent"
 */
export function profileName(raw: string): string {
	const name = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
	if (!NAME.test(name)) {
		throw new FgjError(
			"usage",
			`Profile names use a-z, 0-9, _ and -, start with a letter or digit, and have at most 40 characters. Got "${raw}".`,
			"fgj help auth",
		);
	}
	return name;
}

function names(store: Store): string {
	return Object.keys(store.profiles).join(", ") || "(none)";
}

/**
 * Picks the profile that the harness or the call selected. `FGJ_PROFILE` comes
 * from the harness config; `--as` comes from the command. When both are set,
 * they must agree, so a model cannot switch the identity that the harness set.
 *
 * @param store - The token file.
 * @param envProfile - The value of `FGJ_PROFILE`, if any.
 * @param asFlag - The value of `--as`, if any.
 * @returns The selected profile, or `undefined` when nothing selects one.
 * @throws {FgjError} `identity_mismatch` when the two disagree; `auth` for an unknown name.
 * @example
 * selectProfile(store, process.env.FGJ_PROFILE, undefined)?.name; // "dm"
 */
export function selectProfile(
	store: Store,
	envProfile: string | undefined,
	asFlag: string | undefined,
): Profile | undefined {
	const env = envProfile || undefined;
	if (env && asFlag && env !== asFlag) {
		throw new FgjError(
			"identity_mismatch",
			`FGJ_PROFILE is ${env}, but the command says --as ${asFlag}. The harness sets the identity; remove --as.`,
			"fgj auth status",
		);
	}
	const name = asFlag ?? env;
	if (name === undefined) return undefined;
	const entry = Object.hasOwn(store.profiles, name)
		? store.profiles[name]
		: undefined;
	if (!entry) {
		throw new FgjError(
			"auth",
			`No profile "${name}". Profiles: ${names(store)}. A human must run fgj auth --profile ${name}.`,
			"fgj auth status",
		);
	}
	// A bound-only profile acts only through a harness binder, never by --as.
	if (entry.boundOnly && !env) {
		throw new FgjError(
			"identity_mismatch",
			`The profile ${name} is bound only: only a harness binder can act as it, never --as. Remove --as. A human installs a binder for the lane (fgj rules install).`,
			"fgj auth status",
		);
	}
	return { name, ...entry };
}

/**
 * Picks the identity for a target host. A selected profile must belong to that
 * host. With no selection, the profile that a human marked as the host's default
 * is used. Without a default the call fails closed, even with one profile, so no
 * agent acts as an account that no human chose for it. With no profile for the
 * host, the env tokens apply when `FGJ_URL` names it.
 *
 * @param store - The token file.
 * @param selected - The result of {@link selectProfile}.
 * @param host - The target base URL.
 * @param env - The process env, for `FGJ_URL` and the env tokens.
 * @returns The identity and its tokens.
 * @throws {FgjError} An auth error when no single identity fits.
 * @example
 * // With store.defaults = { "https://git.example.com": "dm" }:
 * pickIdentity(store, undefined, "https://git.example.com", process.env).as; // "dm"
 */
export function pickIdentity(
	store: Store,
	selected: Profile | undefined,
	host: string,
	env: Record<string, string | undefined>,
): Identity {
	if (selected) {
		if (selected.host !== host) {
			throw new FgjError(
				"auth",
				`The profile ${selected.name} is for ${selected.host}, but the target is ${host}.`,
				"fgj auth status",
			);
		}
		const { name, user, read, write, web } = selected;
		return { as: name, user, read, write, ...(web ? { web } : {}) };
	}
	const marked = store.defaults[host];
	const entry =
		marked !== undefined && Object.hasOwn(store.profiles, marked)
			? store.profiles[marked]
			: undefined;
	if (marked !== undefined && entry?.host === host && entry.boundOnly) {
		throw new FgjError(
			"auth",
			`The default profile ${marked} for ${host} is bound only, and nothing binds this call. A human installs a harness binder for the lane (fgj rules install), or marks another default with fgj auth default.`,
			"fgj auth status",
		);
	}
	if (marked !== undefined && entry?.host === host) {
		const { user, read, write, web } = entry;
		return { as: marked, user, read, write, ...(web ? { web } : {}) };
	}
	const matches = Object.keys(store.profiles).filter(
		(name) => store.profiles[name]?.host === host,
	);
	// Name the human fix only. An agent that picks an account itself defeats the rule.
	if (matches.length === 1) {
		const [only] = matches as [string];
		throw new FgjError(
			"auth",
			`The only profile for ${host} is ${only}, but no profile is the default, and nothing selects one. A human runs fgj auth default ${only}, or installs a harness binder (fgj rules install).`,
			`fgj auth default ${only}`,
		);
	}
	if (matches.length > 1) {
		throw new FgjError(
			"auth",
			`${matches.length} profiles for ${host}: ${matches.join(", ")}; no profile is the default, and nothing selects one. A human runs fgj auth default <profile>, or installs a harness binder (fgj rules install).`,
			"fgj auth status",
		);
	}
	const envUrl = env.FGJ_URL?.replace(/\/+$/, "");
	if (envUrl === host && (env.FGJ_READ_TOKEN || env.FGJ_WRITE_TOKEN)) {
		return {
			as: "env",
			user: undefined,
			read: env.FGJ_READ_TOKEN || undefined,
			write: env.FGJ_WRITE_TOKEN || undefined,
		};
	}
	throw new FgjError(
		"auth",
		`No profile for ${host}. A human must run fgj auth ${host}.`,
		"fgj auth status",
	);
}

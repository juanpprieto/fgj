import { FgjError } from "../core/errors.ts";

/** Where a call goes: the Forgejo base URL and the repository. */
export interface Target {
	baseUrl: string;
	owner: string;
	name: string;
	/** True when `--repo` gave owner and name. `next` commands repeat it. */
	repoFromFlag: boolean;
	/** Which source gave the host: an issue `url`, `origin`, `stored`, or `env`. */
	hostSource: "url" | "origin" | "stored" | "env";
}

/** The parts of a git remote URL that fgj uses. */
export interface Remote {
	baseUrl: string;
	owner: string;
	name: string;
}

/**
 * The regex source of a valid `--repo owner/name`, after a trailing `.git` is
 * dropped. The pi gate checks `--repo` values against it.
 */
export const REPO_SLUG_SHAPE = String.raw`^(?!\.\.?/)[A-Za-z0-9_.-]+/(?!\.\.?$)[A-Za-z0-9_.-]+$`;
const SLUG = new RegExp(REPO_SLUG_SHAPE);

/**
 * Reads a git remote URL. An ssh remote maps to https on the same host. An
 * http(s) remote keeps its scheme, port, and any path prefix.
 *
 * @param url - The remote URL, for example `git@git.example.com:alice/tool.git`.
 * @returns The base URL, owner, and name, or `null` when the URL has no owner/name.
 * @example
 * parseRemote("git@git.example.com:alice/tool.git");
 * // { baseUrl: "https://git.example.com", owner: "alice", name: "tool" }
 */
export function parseRemote(url: string): Remote | null {
	const remote = parseRemoteParts(url);
	// Owner and name go into API paths, so they must be plain Forgejo slugs.
	if (!remote || !isSlugPart(remote.owner) || !isSlugPart(remote.name)) {
		return null;
	}
	return remote;
}

function isSlugPart(part: string): boolean {
	return /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..";
}

function parseRemoteParts(url: string): Remote | null {
	const scp = /^[\w.-]+@([\w.-]+):\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
	if (scp) {
		const [, host, owner, name] = scp as unknown as [
			string,
			string,
			string,
			string,
		];
		return { baseUrl: `https://${host}`, owner, name };
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const parts = parsed.pathname
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	if (parts.length < 2) return null;
	const name = parts.pop() as string;
	const owner = parts.pop() as string;
	const prefix = parts.length > 0 ? `/${parts.join("/")}` : "";
	if (parsed.protocol === "ssh:") {
		return { baseUrl: `https://${parsed.hostname}${prefix}`, owner, name };
	}
	if (parsed.protocol === "http:" || parsed.protocol === "https:") {
		return {
			baseUrl: `${parsed.protocol}//${parsed.host}${prefix}`,
			owner,
			name,
		};
	}
	return null;
}

/**
 * Reads the `origin` URL of the git work tree at `cwd`.
 *
 * @param cwd - The directory to ask git about.
 * @returns The remote URL, or `null` outside a work tree or with no `origin`.
 * @example
 * originUrl(process.cwd()); // "git@git.example.com:alice/tool.git"
 */
export function originUrl(cwd: string): string | null {
	const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
		cwd,
		stdout: "pipe",
		stderr: "ignore",
	});
	if (proc.exitCode !== 0) return null;
	return proc.stdout.toString().trim() || null;
}

/**
 * Reads the branch that is checked out in the git work tree at `cwd`, and its
 * commit.
 *
 * @param cwd - The directory to ask git about.
 * @returns The branch name and the full commit SHA, or `null` outside a work
 *   tree, on a detached HEAD, or on a branch with no commit.
 * @example
 * checkedOut(process.cwd()); // { branch: "feat/login", sha: "3f2c…" }
 */
export function checkedOut(
	cwd: string,
): { branch: string; sha: string } | null {
	const git = (...args: string[]) => {
		const proc = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
		});
		return proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
	};
	// --short can print heads/<name> when a tag has the same name.
	const ref = git("symbolic-ref", "--quiet", "HEAD");
	const branch = ref.startsWith("refs/heads/")
		? ref.slice("refs/heads/".length)
		: "";
	const sha = branch ? git("rev-parse", "--verify", "--quiet", "HEAD") : "";
	return branch && sha ? { branch, sha } : null;
}

/** The inputs that decide the target. */
export interface TargetInputs {
	origin: string | null;
	/** The host and repository that the argument names, for example an issue URL. */
	urlRemote: Remote | undefined;
	repoFlag: string | undefined;
	/** The hosts that may supply the host when nothing else does. One is used; more is an error. */
	storedHosts: readonly string[];
	/** Every host with a profile. `origin` counts only when its host is one of these or FGJ_URL. */
	knownHosts?: readonly string[];
	envUrl: string | undefined;
	helpHint: string;
}

/**
 * Picks the host and repository for a call.
 *
 * - An issue URL in the arguments wins: it names the host and the repository.
 * - Otherwise the host comes from `origin`, else the one stored host, else
 *   `FGJ_URL`. `origin` counts only when its host is stored or is `FGJ_URL`, so a
 *   GitHub clone never sends a call to github.com.
 * - `--repo` changes only owner and name. A trailing `.git` is dropped.
 *
 * @param inputs - The origin URL, the URL argument, `--repo`, the stored hosts, and `FGJ_URL`.
 * @returns The target and the source of its host.
 * @throws {FgjError} A usage error when no source gives a host or a repository.
 * @example
 * resolveTarget({ origin: null, urlRemote: undefined, repoFlag: "alice/tool", storedHosts: ["https://git.example.com"], envUrl: undefined, helpHint: "fgj help" });
 */
export function resolveTarget(inputs: TargetInputs): Target {
	const repoFlag = inputs.repoFlag?.replace(/\.git$/, "");
	// A . or .. part would let URL parsing move the path out of the repository.
	if (repoFlag !== undefined && !SLUG.test(repoFlag)) {
		throw new FgjError(
			"usage",
			`--repo needs owner/name, got "${inputs.repoFlag}".`,
			inputs.helpHint,
		);
	}
	const envUrl = inputs.envUrl?.replace(/\/+$/, "") || undefined;
	const url = inputs.urlRemote;
	if (url) {
		const slug = `${url.owner}/${url.name}`;
		if (repoFlag !== undefined && repoFlag !== slug) {
			throw new FgjError(
				"usage",
				`The URL names ${slug}, but --repo names ${repoFlag}. Remove --repo.`,
				inputs.helpHint,
			);
		}
		return { ...url, repoFromFlag: false, hostSource: "url" };
	}
	const known = new Set([
		...(inputs.knownHosts ?? inputs.storedHosts),
		...(envUrl ? [envUrl] : []),
	]);
	const parsed = inputs.origin ? parseRemote(inputs.origin) : null;
	const remote = parsed && known.has(parsed.baseUrl) ? parsed : null;
	const unknownOrigin = parsed && !remote ? parsed.baseUrl : null;
	let baseUrl: string;
	let hostSource: Target["hostSource"];
	if (remote) {
		baseUrl = remote.baseUrl;
		hostSource = "origin";
	} else if (inputs.storedHosts.length === 1) {
		baseUrl = inputs.storedHosts[0] as string;
		hostSource = "stored";
	} else if (envUrl) {
		baseUrl = envUrl;
		hostSource = "env";
	} else {
		const origin = unknownOrigin
			? `git origin ${unknownOrigin} is not a stored host`
			: "this directory has no git origin";
		const stored =
			inputs.storedHosts.length > 1
				? `${inputs.storedHosts.length} hosts are stored`
				: "no host is stored";
		throw new FgjError(
			"usage",
			`No Forgejo host: ${origin}, ${stored}, and FGJ_URL is not set. A human must run fgj auth.`,
			unknownOrigin ? `fgj auth ${unknownOrigin}` : "fgj auth",
		);
	}
	if (repoFlag !== undefined) {
		const [owner, name] = repoFlag.split("/") as [string, string];
		return { baseUrl, owner, name, repoFromFlag: true, hostSource };
	}
	if (!remote) {
		const why = unknownOrigin
			? `git origin ${unknownOrigin} is not a stored Forgejo host`
			: "this directory has no git origin";
		throw new FgjError(
			"usage",
			`No repository: ${why}. Add --repo owner/name at the end.`,
			inputs.helpHint,
		);
	}
	return {
		baseUrl,
		owner: remote.owner,
		name: remote.name,
		repoFromFlag: false,
		hostSource,
	};
}

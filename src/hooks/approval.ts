import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * One-time approvals for `fgj destroy` in pi. pi runs any command that its
 * extensions pass, so the fgj pi adapter writes an approval file after the
 * human approves a call, and hands its token to that call only. fgj checks the
 * token and removes the file, so each approval works once. Every lane runs as
 * the same OS user, so this stops accidents, not a model that reads the folder.
 */

type Env = Record<string, string | undefined>;

/** How long an approval stays valid after the human approves it. */
export const APPROVAL_TTL_MS = 120_000;

/** The env variable that carries the token to the approved call. */
export const APPROVAL_ENV = "FGJ_APPROVAL";

/** A token: a random UUID, so it can name a file and nothing else. */
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The folder that holds the approval files, beside the audit log.
 *
 * @param env - The process env. `XDG_STATE_HOME` wins over `HOME`.
 * @returns The absolute folder path.
 * @example
 * approvalDir({ HOME: "/Users/alice" }); // "/Users/alice/.local/state/fgj/approvals"
 */
export function approvalDir(env: Env): string {
	const base = env.XDG_STATE_HOME || join(env.HOME ?? "", ".local", "state");
	return join(base, "fgj", "approvals");
}

/**
 * Removes approvals that expired unused, such as one for a call that failed
 * before fgj checked it.
 */
function sweep(dir: string, now: number): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!TOKEN.test(name)) continue;
		const file = join(dir, name);
		try {
			const expires = Number(JSON.parse(readFileSync(file, "utf8")).expires);
			if (!(now <= expires)) unlinkSync(file);
		} catch {
			// Another call used or removed it.
		}
	}
}

/**
 * Uses one approval: it removes the token's file, and it accepts the token only
 * when this call removed the file and the approval is still fresh.
 *
 * @param env - The process env, with the token in `FGJ_APPROVAL`.
 * @param now - The current time in milliseconds.
 * @returns True when the call holds a fresh approval that no other call used.
 * @example
 * consumeApproval(process.env, Date.now()); // false when FGJ_APPROVAL is unset
 */
export function consumeApproval(env: Env, now: number): boolean {
	sweep(approvalDir(env), now);
	const token = env[APPROVAL_ENV];
	if (!token || !TOKEN.test(token)) return false;
	const file = join(approvalDir(env), token);
	let expires: number;
	try {
		expires = Number(JSON.parse(readFileSync(file, "utf8")).expires);
		// Only the call that removes the file may use it.
		unlinkSync(file);
	} catch {
		return false;
	}
	return Number.isFinite(expires) && now <= expires;
}

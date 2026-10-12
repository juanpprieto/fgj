import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

type Env = Record<string, string | undefined>;

/** One audit line: who did which write, where, and what came of it. */
export interface AuditEntry {
	as: string;
	user: string | undefined;
	/** Unknown when the call failed before fgj resolved the target. */
	host?: string;
	repo?: string;
	/** The profile that a refused `--as` asked for. */
	attempted?: string;
	argv: readonly string[];
	cwd: string;
	result?: Record<string, unknown>;
	error?: string;
}

/**
 * Finds the audit log.
 *
 * @param env - The process env. `XDG_STATE_HOME` wins over `HOME`.
 * @returns The absolute path of `fgj/audit.jsonl`.
 * @example
 * auditFile({ HOME: "/Users/alice" }); // "/Users/alice/.local/state/fgj/audit.jsonl"
 */
export function auditFile(env: Env): string {
	const base = env.XDG_STATE_HOME || join(env.HOME ?? "", ".local", "state");
	return join(base, "fgj", "audit.jsonl");
}

/** Names the harness and its session from the env vars that each harness sets. */
function harnessOf(env: Env): { harness?: string; session?: string } {
	if (env.CLAUDECODE === "1") return { harness: "claude" };
	if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) {
		return {
			harness: "codex",
			...(env.CODEX_THREAD_ID ? { session: env.CODEX_THREAD_ID } : {}),
		};
	}
	if (env.PI_CODING_AGENT || env.PI_SESSION_ID) {
		return {
			harness: "pi",
			...(env.PI_SESSION_ID ? { session: env.PI_SESSION_ID } : {}),
		};
	}
	return {};
}

/**
 * Appends one write to the local audit log (mode 0600). It never holds a token:
 * the dispatcher redacts argv, which can hold free text such as a title, and the
 * result holds only ids and flags. A failed append never fails the command.
 *
 * @param env - The process env, for the path and the harness fields.
 * @param entry - The write to record.
 * @returns Nothing.
 * @example
 * await appendAudit(process.env, { as: "qa", user: "qa-bot", host, repo, argv, cwd, result: { changed: true } });
 */
export async function appendAudit(env: Env, entry: AuditEntry): Promise<void> {
	try {
		const path = auditFile(env);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const line = {
			ts: new Date().toISOString(),
			...entry,
			...harnessOf(env),
		};
		await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
		await chmod(path, 0o600);
	} catch {
		// Best effort: an audit failure must not turn a done write into an error.
	}
}

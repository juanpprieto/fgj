/** Fixed process exit codes. Agents branch on these, so they never change. */
export const EXIT = {
	ok: 0,
	api: 1,
	usage: 2,
	auth: 3,
	not_found: 4,
	conflict: 5,
	risk_mismatch: 6,
	identity_mismatch: 7,
} as const;

/** The `error.code` values that fgj writes to stderr. */
export type ErrorCode = Exclude<keyof typeof EXIT, "ok">;

/**
 * An expected failure. fgj prints it to stderr as
 * `{"error":{"code","message","hint"}}` and exits with the code's fixed number.
 *
 * @example
 * throw new FgjError("not_found", "Issue 9 not found.", "fgj help comment list");
 */
export class FgjError extends Error {
	/**
	 * Makes an fgj error from its class, message, and hint.
	 *
	 * @param code - The error class. It picks the exit code.
	 * @param message - One sentence that says what is wrong.
	 * @param hint - A runnable fgj command that helps, for example `fgj help`.
	 * @param status - The HTTP status that caused it, when a server answered.
	 *   It never prints; a verb reads it to tell server answers apart.
	 * @example
	 * throw new FgjError("usage", "Missing issue number.", "fgj help comment list");
	 */
	constructor(
		readonly code: ErrorCode,
		message: string,
		readonly hint: string,
		readonly status?: number,
	) {
		super(message);
	}

	/**
	 * @returns The fixed exit code for this error class.
	 * @example
	 * process.exitCode = err.exitCode;
	 */
	get exitCode(): number {
		return EXIT[this.code];
	}

	/**
	 * Gives the error as fgj prints it on stderr.
	 *
	 * @returns The stderr shape, `{error:{code,message,hint}}`.
	 * @example
	 * JSON.stringify(err); // {"error":{"code":"usage",...}}
	 */
	toJSON(): { error: { code: ErrorCode; message: string; hint: string } } {
		return {
			error: { code: this.code, message: this.message, hint: this.hint },
		};
	}
}

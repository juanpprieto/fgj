/** Removes known secrets from text before it leaves the process. */
export interface Redactor {
	/** Registers a value, such as a token, that must never appear in output. */
	add(value: string | undefined): void;
	/** Returns the text with every registered value replaced by `[redacted]`. */
	apply(text: string): string;
	/** True when the text holds any registered value. */
	contains(text: string): boolean;
}

/**
 * Makes an empty redactor. `main` wraps stdout, stderr, and the trace with it,
 * so a server error that echoes a token cannot print that token.
 *
 * @returns A redactor with no registered values.
 * @example
 * const redact = createRedactor();
 * redact.add(token);
 * redact.apply(`bad token ${token}`); // "bad token [redacted]"
 */
export function createRedactor(): Redactor {
	const secrets = new Set<string>();
	return {
		add(value) {
			// Very short values would redact ordinary text; real tokens are long.
			if (value && value.length >= 8) secrets.add(value);
		},
		apply(text) {
			let out = text;
			for (const s of secrets) out = out.replaceAll(s, "[redacted]");
			return out;
		},
		contains(text) {
			for (const s of secrets) if (text.includes(s)) return true;
			return false;
		},
	};
}

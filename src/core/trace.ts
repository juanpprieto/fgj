import { appendFileSync } from "node:fs";
import type { Redactor } from "./redact.ts";

/** One trace line. `ev` names the event; the other keys depend on it. */
export type TraceEvent = { ev: string } & Record<string, unknown>;

/** Writes trace events. A tracer made with no `FGJ_TRACE` does nothing. */
export interface Tracer {
	readonly enabled: boolean;
	/** Writes one event as a JSON line, with `t` in milliseconds since start. */
	emit(event: TraceEvent): void;
}

/**
 * Makes the tracer that `FGJ_TRACE` selects: `1` writes JSON lines to stderr, a
 * path appends them to that file, and unset or empty turns tracing off.
 *
 * @param env - The process env. Only `FGJ_TRACE` is read.
 * @param stderr - The sink for `FGJ_TRACE=1`. It must already redact secrets.
 * @param redact - Removes secrets from lines that go to a trace file.
 * @returns A tracer. It never throws, so tracing cannot break a command.
 * @example
 * const trace = createTracer(process.env, (line) => process.stderr.write(line), redact);
 * trace.emit({ ev: "exit", code: 0 });
 */
export function createTracer(
	env: Record<string, string | undefined>,
	stderr: (line: string) => void,
	redact: Redactor,
): Tracer {
	const target = env.FGJ_TRACE;
	if (!target) return { enabled: false, emit() {} };
	const start = performance.now();
	const write =
		target === "1"
			? stderr
			: (line: string) =>
					appendFileSync(target, redact.apply(line), { mode: 0o600 });
	return {
		enabled: true,
		emit(event) {
			try {
				const t = Math.round(performance.now() - start);
				write(`${JSON.stringify({ t, ...event })}\n`);
			} catch {
				// Tracing is best effort: a failed trace write never fails the command.
			}
		},
	};
}

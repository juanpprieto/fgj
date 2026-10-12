import { PROFILE_NAME_SHAPE } from "../auth/identity.ts";
import type { Io } from "../core/dispatch.ts";
import { EXIT, FgjError } from "../core/errors.ts";
import { toLine } from "../core/output.ts";
import { type Binding, gate } from "./gate.ts";

/** The harnesses whose adapters call `fgj hook`. */
const HOOK_HARNESSES = ["pi"] as const;

const PROFILE = new RegExp(PROFILE_NAME_SHAPE);

/** The event that the pi adapter sends: the bash command, and its lane's profile. */
interface PiEvent {
	command: string;
	profile?: string;
}

/** Reads and checks the pi adapter's event. */
function piEvent(text: string): PiEvent {
	let event: unknown;
	try {
		event = JSON.parse(text);
	} catch {
		throw new FgjError(
			"usage",
			"fgj hook pi reads one JSON object on stdin: {command, profile?}.",
			"fgj help hook",
		);
	}
	const { command, profile } = (event ?? {}) as Record<string, unknown>;
	if (typeof command !== "string") {
		throw new FgjError(
			"usage",
			"fgj hook pi needs a string command in its input.",
			"fgj help hook",
		);
	}
	if (
		profile !== undefined &&
		(typeof profile !== "string" || !PROFILE.test(profile))
	) {
		throw new FgjError(
			"usage",
			`fgj hook pi got a profile that is not a profile name: ${JSON.stringify(profile)}.`,
			"fgj help hook",
		);
	}
	return profile === undefined ? { command } : { command, profile };
}

/**
 * Runs `fgj hook <harness>`: a harness adapter sends one event on stdin, and
 * fgj prints what the harness does with the command. It sends no request and
 * reads no token. The adapter owns the dialog and the approval token.
 *
 * @param words - The words after `hook`, for example `["pi"]`.
 * @param io - The CLI streams; `readInput` gives stdin.
 * @returns The exit code.
 * @throws {FgjError} A usage error for an unknown harness or a bad event.
 * @example
 * await runHook(["pi"], io); // prints {"action":"pass"}
 */
export async function runHook(
	words: readonly string[],
	io: Io,
): Promise<number> {
	const [harness, ...rest] = words;
	if (
		!HOOK_HARNESSES.includes(harness as (typeof HOOK_HARNESSES)[number]) ||
		rest.length > 0
	) {
		throw new FgjError(
			"usage",
			`Expected fgj hook ${HOOK_HARNESSES.join("|")}, got "${words.join(" ")}".`,
			"fgj help hook",
		);
	}
	if (!io.readInput) {
		throw new FgjError(
			"usage",
			"fgj hook reads its event from a pipe on stdin. The fgj harness adapter runs it.",
			"fgj help hook",
		);
	}
	const event = piEvent(await io.readInput());
	const binding: Binding | undefined = event.profile
		? { profile: event.profile }
		: undefined;
	io.stdout(toLine(gate(event.command, binding)));
	return EXIT.ok;
}

#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { writeSync } from "node:fs";
import { main } from "./core/dispatch.ts";

/** True after stdin ends: a later question then reads as an empty answer. */
let stdinEnded = false;

/**
 * Reads one line from the terminal. With `secret`, echo is off: the terminal
 * shows nothing while the human types or pastes.
 *
 * @param question - The prompt text, written to stderr.
 * @param secret - True to turn echo off.
 * @returns The line, without the Enter key.
 * @example
 * const token = await prompt("Read token (input hidden): ", true);
 */
function prompt(question: string, secret: boolean): Promise<string> {
	const stdin = process.stdin;
	if (stdinEnded) {
		writeSync(2, `${question}\n`);
		return Promise.resolve("");
	}
	// Echo goes off before the question shows, so a token typed or pasted the
	// moment the prompt appears never reaches the screen.
	if (secret) stdin.setRawMode(true);
	writeSync(2, question);
	return new Promise((resolve) => {
		let line = "";
		let inEscape = false;
		const done = (value: string) => {
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			if (secret) {
				stdin.setRawMode(false);
				writeSync(2, "\n");
			}
			stdin.pause();
			resolve(value);
		};
		const onData = (chunk: Buffer) => {
			for (const ch of chunk.toString("utf8")) {
				// Skip escape sequences, such as the bracketed-paste markers around a paste.
				if (inEscape) {
					if (/[A-Za-z~]/.test(ch)) inEscape = false;
					continue;
				}
				if (ch === "\u001b") inEscape = true;
				else if (ch === "\u0003") {
					if (secret) stdin.setRawMode(false);
					writeSync(2, "\n");
					process.exit(130);
				} else if (ch === "\r" || ch === "\n") return done(line);
				else if (ch === "\u0004" && line === "") return done("");
				else if (ch === "\u007f" || ch === "\b") line = line.slice(0, -1);
				else if (ch >= " ") line += ch;
			}
		};
		// With echo on, Ctrl-D closes stdin instead of sending a byte. It ends the
		// answer, so a [y/N] question reads it as no and fgj still prints a result.
		const onEnd = () => {
			stdinEnded = true;
			done(line);
		};
		stdin.resume();
		stdin.on("data", onData);
		stdin.once("end", onEnd);
	});
}

// Leave the terminal with echo on, whatever happens.
process.on("exit", () => {
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
});

const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);

// Write synchronously so process.exit cannot cut off a result or an error.
// No top-level await: the bytecode build compiles to CommonJS.
main(process.argv.slice(2), {
	cwd: process.cwd(),
	env: process.env,
	stdout: (text) => writeSync(1, text),
	stderr: (text) => writeSync(2, text),
	...(interactive ? { prompt } : {}),
	...(process.stdin.isTTY ? {} : { readInput: () => Bun.stdin.text() }),
}).then((code) => process.exit(code));

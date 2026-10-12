/**
 * Readers for Forgejo Actions job logs. A job log is plain text: each line
 * starts with a 29-character timestamp, many lines carry ANSI colors, and the
 * runner marks only the first step, so fgj finds failures by their error
 * lines, not by step markers.
 */

/** The longest line that fgj returns. The runner allows 64 KB lines. */
export const LOG_LINE_MAX = 400;

/** The most lines in an error block. */
export const ERROR_BLOCK_MAX = 60;

/** The line that fgj puts between two parts of a log that are not adjacent. */
export const GAP = "…";

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes start with ESC.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** OSC sequences, such as OSC-8 hyperlinks: ESC ] … BEL, or ESC ] … ESC \\. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC codes start with ESC.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** A user and password or token in a URL, which the runner masks only when it knows them. */
const URL_CREDENTIALS = /(:\/\/)[^/@\s:]+:[^/@\s]+@/g;

/**
 * Makes a job log readable: it removes the timestamp prefix, the ANSI and OSC
 * codes, and the progress text before a carriage return; it drops every line
 * with a masked value (`***`), hides a user and password in a URL, and cuts
 * long lines.
 *
 * @param text - The log as Forgejo serves it.
 * @returns The lines.
 * @example
 * cleanLog("2026-09-27T08:13:12.1708799Z \x1b[31mFAIL\x1b[39m x\n"); // ["FAIL x"]
 */
export function cleanLog(text: string): string[] {
	const lines: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		// Progress output rewrites its line with \r: keep what shows last.
		const shown = raw.slice(raw.lastIndexOf("\r") + 1);
		const line = shown
			.replace(STAMP, "")
			.replace(OSC, "")
			.replace(ANSI, "")
			.replace(URL_CREDENTIALS, "$1[redacted]@");
		if (line.includes("***")) continue;
		lines.push(
			line.length > LOG_LINE_MAX
				? `${line.slice(0, LOG_LINE_MAX)}${GAP}`
				: line,
		);
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * Lines that mark an error: GitHub-style annotations, the runner, pnpm and npm,
 * Vitest and Jest, tsc, cargo and other `error:` lines, eslint, pytest, and
 * docker build.
 */
const ANCHORS: readonly RegExp[] = [
	/^::error\b/,
	/^##\[error\]/,
	/exitcode '\d+': failure/,
	/\bELIFECYCLE\b/,
	/npm ERR!/,
	/^\s*FAIL\s/,
	/^\s*×\s/,
	/\berror TS\d+:/,
	/^\s*(?:\w+)?Error:\s/,
	/^\s*error(?:\[\w+\])?:/i,
	/^\s*\d+:\d+\s+error\s/,
	/^FAILED\s/,
	/^E\s{2,}\S/,
	/^(?:#\d+ )?ERROR:/,
	/^\s*Test Files\s+\d+ failed/,
];

/** The runner's line that ends the step that failed. Later lines are post steps. */
const EXIT = /exitcode '\d+': failure/;

/** Context around an anchor: some lines before it, and more after it for a stack. */
const BEFORE = 3;
const AFTER = 8;
/** Context before the exit line when no other line marks the error. */
const BEFORE_EXIT_ONLY = 30;

/** Merges line windows that overlap or touch, and joins them with {@link GAP}. */
function windows(
	lines: readonly string[],
	ranges: [number, number][],
): string[][] {
	const merged: [number, number][] = [];
	for (const [from, to] of ranges.sort((a, b) => a[0] - b[0])) {
		const last = merged[merged.length - 1];
		if (last && from <= last[1] + 2) last[1] = Math.max(last[1], to);
		else merged.push([from, to]);
	}
	return merged.map(([from, to]) => lines.slice(from, to + 1));
}

/** Joins parts, with {@link GAP} between them. */
function join(parts: readonly string[][]): string[] {
	return parts.flatMap((p, i) => (i === 0 ? p : [GAP, ...p]));
}

/**
 * Finds the lines that explain a failure: each error line with a few lines
 * around it, up to the runner's last failure line. It keeps every line from
 * the first error line in the 30 lines before that line; with none there, it
 * shows those 30 lines. When the parts pass the limit, it keeps the parts
 * nearest the end, where the failure is, and starts with {@link GAP} to show
 * the cut.
 *
 * @param lines - The lines from {@link cleanLog}.
 * @param max - The most lines to return, 2 or more.
 * @returns The error block, or an empty list when the log has no error line.
 * @example
 * errorBlock(["ok", "FAIL a.test.ts", "Error: boom"]); // ["ok", "FAIL a.test.ts", "Error: boom"]
 */
export function errorBlock(
	lines: readonly string[],
	max: number = ERROR_BLOCK_MAX,
): string[] {
	// The last failed step ends the job; a step before it may have failed with
	// continue-on-error. Later lines are post steps.
	const exit = lines.findLastIndex((l) => EXIT.test(l));
	const end = exit >= 0 ? exit : lines.length - 1;
	const ranges: [number, number][] = [];
	// The first error line in the lines that lead to the runner's exit line.
	let near = -1;
	for (let i = 0; i <= end; i++) {
		const line = lines[i] as string;
		if (ANCHORS.some((a) => a.test(line))) {
			ranges.push([Math.max(0, i - BEFORE), Math.min(end, i + AFTER)]);
			const leads = i >= end - BEFORE_EXIT_ONLY && i < end && !EXIT.test(line);
			if (leads && near < 0) near = i;
		}
	}
	// Keep every line from that error line to the exit line; with none, show
	// the lines before the exit line.
	if (exit >= 0) {
		const from = near >= 0 ? near - BEFORE : exit - BEFORE_EXIT_ONLY;
		ranges.push([Math.max(0, from), exit]);
	}
	const parts = windows(lines, ranges);
	if (join(parts).length <= max) return join(parts);
	// The failure sits close to where the job ended, and harmless error lines
	// from passing steps come earlier: fill the budget from the end. A first
	// gap line says that earlier lines were left out.
	const budget = Math.max(1, max - 1);
	const kept: string[][] = [];
	let size = 0;
	for (let k = parts.length - 1; k >= 0; k--) {
		const part = parts[k] as string[];
		const add = part.length + (kept.length > 0 ? 1 : 0);
		if (size + add > budget) {
			if (kept.length === 0) kept.unshift(part.slice(-budget));
			break;
		}
		kept.unshift(part);
		size += add;
	}
	return [GAP, ...join(kept)];
}

/**
 * Finds the lines that hold any of the texts, without case, each with a few
 * lines around it.
 *
 * @param lines - The lines from {@link cleanLog}.
 * @param texts - The texts to find.
 * @param context - The lines before and after each hit.
 * @returns The hits with context, and the number of lines that matched.
 * @example
 * matchLines(["a", "ETIMEDOUT", "b"], ["etimedout"], 1).lines; // ["a", "ETIMEDOUT", "b"]
 */
export function matchLines(
	lines: readonly string[],
	texts: readonly string[],
	context = 3,
): { lines: string[]; hits: number } {
	const wanted = texts.map((t) => t.toLowerCase());
	const ranges: [number, number][] = [];
	lines.forEach((line, i) => {
		const lower = line.toLowerCase();
		if (wanted.some((t) => lower.includes(t))) {
			ranges.push([
				Math.max(0, i - context),
				Math.min(lines.length - 1, i + context),
			]);
		}
	});
	return { lines: join(windows(lines, ranges)), hits: ranges.length };
}

/**
 * Reads how a job ended from the runner's last line.
 *
 * @param lines - The lines from {@link cleanLog}.
 * @returns `failure`, `success`, or `undefined` while the job has not ended.
 * @example
 * jobResult(["🏁  Job failed"]); // "failure"
 */
export function jobResult(
	lines: readonly string[],
): "failure" | "success" | undefined {
	for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i--) {
		const line = lines[i] as string;
		if (/^🏁\s+Job failed/.test(line)) return "failure";
		if (/^🏁\s+Job succeeded/.test(line)) return "success";
	}
	return undefined;
}

#!/usr/bin/env bun
/**
 * Shows the test Forgejo log as JSON lines. Router lines become
 * `{ts,method,path,status,ms}`; other lines become `{ts,level,msg}`.
 *
 * By default it shows only problems: warnings, errors, and HTTP 4xx/5xx.
 *
 * Usage: bun scripts/forgejo-logs.ts [--since 10m|<RFC 3339 time>] [--all]
 */
import { join, resolve } from "node:path";

/**
 * Names the test server's container. The port is part of the name, so a second
 * worktree on another port never removes the first worktree's server.
 *
 * @param port - The host port, from `FGJ_FORGEJO_PORT` (default 3917).
 * @returns The container name, for example `fgj-forgejo-test-3917`.
 * @example
 * containerName("3918"); // "fgj-forgejo-test-3918"
 */
export function containerName(
	port: string = process.env.FGJ_FORGEJO_PORT ?? "3917",
): string {
	return `fgj-forgejo-test-${port}`;
}

/** Reads a Forgejo log time (`YYYY/MM/DD HH:MM:SS`, local time) as a Date. */
function logTime(ts: string): Date | undefined {
	if (!ts) return undefined;
	const d = new Date(ts.replaceAll("/", "-").replace(" ", "T"));
	return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Reads `--since`: an RFC 3339 time, or a duration such as `10m`, `2h`, `30s`. */
function sinceTime(since: string, now: Date): Date | undefined {
	const d = /^(\d+)([smh])$/.exec(since);
	if (d) {
		const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[d[2] as "s" | "m" | "h"];
		return new Date(now.getTime() - Number(d[1]) * unit);
	}
	const t = new Date(since);
	return Number.isNaN(t.getTime()) ? undefined : t;
}

/**
 * True when a log time falls in the window that starts at `from`. Forgejo logs
 * whole seconds, so `from` counts from the start of its second: a line logged in
 * the same second as a command start stays in the window.
 */
function inWindow(ts: string, from: Date | undefined): boolean {
	if (!from) return true;
	const at = logTime(ts);
	const second = new Date(from);
	second.setMilliseconds(0);
	return at === undefined || at >= second;
}

/**
 * Keeps the log lines at or after `since`. A line with no readable time stays,
 * so a parse problem never hides a line.
 *
 * @param lines - Parsed lines from {@link parseLog}. Their times are local time.
 * @param since - An RFC 3339 time or a duration such as `10m`.
 * @param now - The current time, for durations.
 * @returns The lines in the window.
 * @example
 * filterSince(parseLog(text), "10m");
 */
export function filterSince(
	lines: LogLine[],
	since: string,
	now: Date = new Date(),
): LogLine[] {
	const from = sinceTime(since, now);
	return lines.filter((l) => inWindow(l.ts, from));
}

/**
 * Keeps the raw log lines at or after `since`, with the same rule as
 * {@link filterSince}.
 *
 * @param text - Raw Forgejo log text. Its times are local time.
 * @param since - An RFC 3339 time or a duration such as `10m`.
 * @param now - The current time, for durations.
 * @returns The lines in the window, joined with new lines.
 * @example
 * filterLogText(await Bun.file("web.log").text(), "10m");
 */
export function filterLogText(
	text: string,
	since: string,
	now: Date = new Date(),
): string {
	const from = sinceTime(since, now);
	return text
		.split("\n")
		.filter((raw) =>
			inWindow(
				/^(\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d)/.exec(raw)?.[1] ?? "",
				from,
			),
		)
		.join("\n");
}

const WEB_LOG = join(
	resolve(import.meta.dir, ".."),
	".forgejo-test",
	"web.log",
);

/** One parsed Forgejo log line. */
export type LogLine =
	| { ts: string; method: string; path: string; status: number; ms: number }
	| { ts: string; level: string; msg: string };

const LINE = /^(\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d) \S+ \[(\w)\] (.*)$/;
const ROUTER =
	/^router: completed (\w+) (\S+) for \S+, (\d{3}) .*? in ([\d.]+)ms/;

/**
 * Parses Forgejo console log text into JSON-ready lines.
 *
 * @param text - Raw log text, one entry per line.
 * @returns The parsed lines. Lines that do not match the Forgejo format are kept as `msg`.
 * @example
 * parseLog("2026/09/24 11:39:47 routers/x.go:1:f() [I] router: completed GET /api/v1/version for 10.0.0.1:0, 200 OK in 0.5ms");
 */
export function parseLog(text: string): LogLine[] {
	const out: LogLine[] = [];
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		const m = LINE.exec(raw);
		if (!m) {
			out.push({ ts: "", level: "?", msg: raw });
			continue;
		}
		const [, ts, level, msg] = m as unknown as [string, string, string, string];
		const r = ROUTER.exec(msg);
		if (r) {
			const [, method, path, status, ms] = r as unknown as [
				string,
				string,
				string,
				string,
				string,
			];
			out.push({ ts, method, path, status: Number(status), ms: Number(ms) });
		} else {
			out.push({ ts, level, msg });
		}
	}
	return out;
}

/**
 * Says whether a log line shows a problem: a warning, an error, or HTTP 4xx/5xx.
 *
 * @param line - A parsed line from {@link parseLog}.
 * @returns True for a problem line.
 * @example
 * isProblem({ ts: "", method: "GET", path: "/x", status: 403, ms: 1 }); // true
 */
export function isProblem(line: LogLine): boolean {
	if ("status" in line) return line.status >= 400;
	return line.level !== "I" && line.level !== "D" && line.level !== "T";
}

/**
 * Reads the test Forgejo log from Podman, or from `web.log` in binary mode.
 *
 * @param since - A Podman `--since` value, for example `10m` or an RFC 3339 time.
 * @returns The raw log text.
 * @example
 * const text = await readServerLog("5m");
 */
export async function readServerLog(since: string): Promise<string> {
	// Pick the source by the same rule as the server's mode, not by which file exists.
	const forced = process.env.FGJ_FORGEJO_MODE;
	const binary =
		forced === "binary" ||
		(forced !== "podman" && process.platform === "linux");
	if (binary) {
		// web.log keeps every run; keep only the lines in the window. Binary mode runs
		// on this machine, so the log's local time matches this clock.
		const web = Bun.file(WEB_LOG);
		if (!(await web.exists())) return "";
		return filterLogText(await web.text(), since);
	}
	try {
		const proc = Bun.spawn(
			["podman", "logs", "--since", since, containerName()],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return out + err;
	} catch {
		// No podman: report no log lines rather than crash the caller.
		return "";
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const sinceAt = args.indexOf("--since");
	const since = sinceAt >= 0 ? (args[sinceAt + 1] ?? "10m") : "10m";
	const lines = parseLog(await readServerLog(since));
	for (const line of args.includes("--all") ? lines : lines.filter(isProblem)) {
		console.log(JSON.stringify(line));
	}
}

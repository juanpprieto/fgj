import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

/**
 * Makes an empty temporary directory that is removed after the test run. A
 * binary test can put a 90 MB build in one, so the directories must not stay.
 *
 * @param prefix - The name prefix, for example `fgj-auth-`.
 * @returns The absolute path of the directory.
 * @example
 * const home = tempDir("fgj-auth-");
 */
export function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/**
 * Makes the base env for a spawned fgj or shell: PATH, HOME, and TMPDIR. A
 * spawn with its own env gets nothing else from the parent, and without
 * TMPDIR its temp files would escape the leak check in `bun run check`.
 *
 * @param home - The HOME for the child, usually a temp work dir.
 * @returns The env values to spread first into the child's env.
 * @example
 * Bun.spawn(["bun", cli], { env: { ...cleanEnv(cwd), FGJ_TRACE: "1" } });
 */
export function cleanEnv(home: string): Record<string, string> {
	return { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmpdir() };
}

// bunfig.toml preloads this file, so this hook runs once, after every test file.
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

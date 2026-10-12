import { join } from "node:path";
import SKILL from "../../skill/fgj/SKILL.md" with { type: "text" };
import type { Io } from "../core/dispatch.ts";
import { EXIT, FgjError } from "../core/errors.ts";
import { toLine } from "../core/output.ts";
import {
	HARNESSES,
	type Harness,
	harnessArg,
	harnessDir,
	installWithConsent,
	readIfExists,
} from "./install.ts";

/** Where each harness looks for the fgj skill. */
function skillFile(harness: Harness, env: Record<string, string | undefined>) {
	return join(harnessDir(harness, env), "skills", "fgj", "SKILL.md");
}

/**
 * Runs `fgj skill`: `show` prints the skill text built into this fgj, `status`
 * compares each harness's copy with it, and `install <harness>` writes it after a
 * human reviews the diff. The text lives in the binary, so it matches this version.
 *
 * @param words - The argv after `skill`.
 * @param io - The process surface. `io.prompt` must exist for an install.
 * @returns The exit code.
 * @throws {FgjError} A usage error for a bad form, a bad harness, or no terminal.
 * @example
 * await runSkill(["show"], io);
 */
export async function runSkill(
	words: readonly string[],
	io: Io,
): Promise<number> {
	const [sub, raw] = words;
	if (sub === "show") {
		io.stdout(toLine({ name: "fgj", content: SKILL }));
		return EXIT.ok;
	}
	if (sub === "status") {
		const harnesses = await Promise.all(
			HARNESSES.map(async (harness) => {
				const file = skillFile(harness, io.env);
				const text = await readIfExists(file);
				const state =
					text === undefined
						? "missing"
						: text === SKILL
							? "current"
							: "outdated";
				return { harness, file, state };
			}),
		);
		io.stdout(toLine({ harnesses }));
		return EXIT.ok;
	}
	if (sub !== "install") {
		throw new FgjError(
			"usage",
			`Expected show, status, or install. Got "${sub ?? ""}".`,
			"fgj help skill",
		);
	}
	const harness = harnessArg(raw, "fgj help skill");
	const file = skillFile(harness, io.env);
	return installWithConsent(
		io,
		{
			harness,
			file,
			before: await readIfExists(file),
			after: SKILL,
			shown: (text) => text ?? "",
		},
		"fgj skill install",
	);
}

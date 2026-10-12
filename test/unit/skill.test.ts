import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { main } from "../../src/core/dispatch.ts";
import { findVerb, MANIFEST } from "../../src/verbs/manifest.ts";
import { tempDir } from "../support/tmp.ts";

const REPO_SKILL = join(
	import.meta.dir,
	"..",
	"..",
	"skill",
	"fgj",
	"SKILL.md",
);

async function fgj(argv: string[], answers?: string[], home = tempHome()) {
	let stdout = "";
	let stderr = "";
	const asked: string[] = [];
	const queue = [...(answers ?? [])];
	const code = await main(argv, {
		cwd: home,
		env: {
			HOME: home,
			CODEX_HOME: join(home, ".codex"),
			CLAUDE_CONFIG_DIR: join(home, ".claude"),
			PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		},
		stdout: (t) => {
			stdout += t;
		},
		stderr: (t) => {
			stderr += t;
		},
		...(answers
			? {
					prompt: async (q: string) => {
						asked.push(q);
						return queue.shift() ?? "";
					},
				}
			: {}),
	});
	return { code, stdout, stderr, asked, home };
}

function tempHome(): string {
	return tempDir("fgj-skill-");
}

describe("fgj skill", () => {
	test("show prints the skill text built into fgj", async () => {
		const r = await fgj(["skill", "show"]);
		expect(r.code).toBe(0);
		const out = JSON.parse(r.stdout);
		expect(out.content).toBe(await Bun.file(REPO_SKILL).text());
		expect(out.content).toStartWith("---\nname: fgj\n");
	});

	test("install needs a human at a terminal", async () => {
		const r = await fgj(["skill", "install", "claude"]);
		expect(r.code).toBe(2);
		expect(JSON.parse(r.stderr).error.message).toMatch(/human/);
	});

	test("install writes skills/fgj/SKILL.md for each harness after a yes", async () => {
		const home = tempHome();
		const where = {
			claude: join(home, ".claude", "skills", "fgj", "SKILL.md"),
			codex: join(home, ".codex", "skills", "fgj", "SKILL.md"),
			pi: join(home, ".pi", "agent", "skills", "fgj", "SKILL.md"),
		};
		for (const [harness, file] of Object.entries(where)) {
			const r = await fgj(["skill", "install", harness], ["y"], home);
			expect(r.code).toBe(0);
			expect(JSON.parse(r.stdout)).toEqual({ changed: true, harness, file });
			expect(r.stderr).toContain("+name: fgj");
			expect(await Bun.file(file).text()).toBe(
				await Bun.file(REPO_SKILL).text(),
			);
		}
		const again = await fgj(["skill", "install", "pi"], ["y"], home);
		expect(JSON.parse(again.stdout).changed).toBe(false);
		expect(again.asked).toEqual([]);
	});

	test("status reports missing, current, and outdated", async () => {
		const home = tempHome();
		await fgj(["skill", "install", "codex"], ["y"], home);
		await Bun.write(
			join(home, ".pi", "agent", "skills", "fgj", "SKILL.md"),
			"old",
		);
		const out = JSON.parse(
			(await fgj(["skill", "status"], undefined, home)).stdout,
		);
		expect(out.harnesses).toEqual([
			expect.objectContaining({ harness: "codex", state: "current" }),
			expect.objectContaining({ harness: "claude", state: "missing" }),
			expect.objectContaining({ harness: "pi", state: "outdated" }),
		]);
	});
});

describe("the skill description", () => {
	/** The frontmatter `description` line of the repo skill. */
	async function description(): Promise<string> {
		const text = await Bun.file(REPO_SKILL).text();
		const line = text.split("\n").find((l) => l.startsWith("description: "));
		return (line ?? "").slice("description: ".length);
	}

	test("the skill stays short: each verb's own rules go in its help notes", async () => {
		const lines = (await Bun.file(REPO_SKILL).text()).split("\n").length;
		expect(lines).toBeLessThanOrEqual(70);
	});

	test("the frontmatter parses as strict YAML, as pi reads it", async () => {
		const text = await Bun.file(REPO_SKILL).text();
		const front = text.split("---\n")[1] ?? "";
		const parsed = Bun.YAML.parse(front) as Record<string, unknown>;
		expect(parsed.name).toBe("fgj");
		expect(parsed.description).toBe(await description());
	});

	test("names each manifest noun in backticks, and no other noun", async () => {
		const named = [...(await description()).matchAll(/`([a-z]+)`/g)].map(
			(m) => m[1],
		);
		const nouns = [...new Set(MANIFEST.map((v) => v.noun))];
		expect(new Set(named)).toEqual(new Set(nouns));
	});

	/** Forgejo work that fgj has no verb for yet, as plain words an overclaim uses. */
	function overclaims(text: string): string[] {
		const words = [
			"merge",
			"label",
			"review",
			"milestone",
			"board",
			"project",
			"dependency",
			"dependencies",
			"release",
			"status",
			"tea",
			"curl",
			"read or write",
		];
		const nouns = new Set(MANIFEST.map((v) => v.noun));
		const actions = new Set(MANIFEST.map((v) => v.action));
		// The noun for dependencies is dep.
		const noun = (w: string) => (w.startsWith("dependenc") ? "dep" : w);
		const found = words.filter(
			(w) =>
				!nouns.has(noun(w)) &&
				!actions.has(w) &&
				new RegExp(`\\b${w}(e?s)?\\b`, "i").test(text),
		);
		// A claim to create pull requests loads the skill for a PR task.
		if (
			!findVerb("pr", "create") &&
			/\bcreate\b[^.;]*\bpull requests?\b/i.test(text)
		) {
			found.push("create pull requests");
		}
		// A universal claim overclaims without naming any one kind of work.
		if (/\b(every|all|any)\s+Forgejo\b/i.test(text)) found.push("universal");
		return found;
	}

	test("claims no Forgejo work that fgj has no verb for", async () => {
		expect(overclaims(await description())).toEqual([]);
		// A claim counts only for work that a verb does.
		expect(
			overclaims("Use only to review pull requests or read a release."),
		).toEqual(["review", "release"]);
		expect(overclaims("Create and merge pull requests.")).toEqual([]);
		// The description before this check claimed every read or write and tea api.
		expect(
			overclaims(
				"Forgejo issues, comments, and pull requests through the fgj CLI. Use it for every Forgejo read or write, and when a task names a Forgejo URL, an issue number on a Forgejo repo, or a `tea api` call.",
			),
		).toEqual(["tea", "read or write", "universal"]);
		expect(overclaims("Use it for all Forgejo work.")).toEqual(["universal"]);
	});

	test("points at fgj help for the rest, and claims no tea api calls", async () => {
		const text = await description();
		expect(text).toContain("`fgj help`");
		expect(text).not.toContain("tea api");
	});
});

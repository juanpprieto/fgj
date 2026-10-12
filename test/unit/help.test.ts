import { describe, expect, test } from "bun:test";
import pkg from "../../package.json";
import { main } from "../../src/core/dispatch.ts";
import { verbHelp } from "../../src/core/help.ts";
import type { Verb } from "../../src/core/verb.ts";
import { commentAdd } from "../../src/verbs/comment.ts";
import { MANIFEST } from "../../src/verbs/manifest.ts";

/** Runs fgj in-process with no network, host, or token. */
async function fgj(...argv: string[]) {
	let stdout = "";
	let stderr = "";
	const code = await main(argv, {
		cwd: "/nonexistent-fgj-test",
		env: {},
		stdout: (t) => {
			stdout += t;
		},
		stderr: (t) => {
			stderr += t;
		},
	});
	return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) : null };
}

describe("fgj help", () => {
	test("top level lists every verb with its signature, under 1.5k tokens", async () => {
		const r = await fgj("help");
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
		// A source run prints "dev"; a binary prints what scripts/build.ts
		// stamps: the package version, a short SHA, and -dirty. Git can make a
		// short SHA longer, so the test uses a full one as the upper bound.
		const release = r.stdout.replace(
			'"version":"dev"',
			`"version":"${pkg.version}+${"0".repeat(40)}-dirty"`,
		);
		expect(release).not.toBe(r.stdout);
		expect(release.length).toBeLessThan(6000);
		expect(Object.keys(r.json.meta)).toEqual([
			"fgj help [<noun> [<action>]]",
			"fgj help <auth|rules|skill>",
		]);
		expect(r.json.meta["fgj help <auth|rules|skill>"]).toContain(
			"An agent can run only their status and show commands. A human runs the others.",
		);
		expect(r.json.grammar).toBe(
			"fgj <read|write|destroy> <noun> <action> <args> [--flags]",
		);
		expect(r.json.verbs).toEqual({
			"fgj read comment list <issue>": expect.any(String),
			"fgj read comment get <comment>": expect.any(String),
			"fgj write comment add <issue> --body-file PATH": expect.any(String),
			"fgj write comment edit <comment> --body-file PATH": expect.any(String),
			"fgj write comment attach <comment> --file PATH": expect.any(String),
			"fgj destroy comment delete <comment>": expect.any(String),
			"fgj read issue get <issue...>": expect.any(String),
			"fgj read issue list": expect.any(String),
			"fgj write issue create --title TEXT": expect.any(String),
			"fgj write issue edit <issue...>": expect.any(String),
			"fgj write issue close <issue...>": expect.any(String),
			"fgj write issue reopen <issue...>": expect.any(String),
			"fgj write dep add <issue> <on...>": expect.any(String),
			"fgj write dep remove <issue> <on...>": expect.any(String),
			"fgj read label list": expect.any(String),
			"fgj write label create --name NAME --color RRGGBB": expect.any(String),
			"fgj write label edit <label>": expect.any(String),
			"fgj read milestone list": expect.any(String),
			"fgj write milestone create --title TEXT": expect.any(String),
			"fgj write milestone edit <milestone>": expect.any(String),
			"fgj write milestone close <milestone>": expect.any(String),
			"fgj write milestone reopen <milestone>": expect.any(String),
			"fgj read pr get <pr...>": expect.any(String),
			"fgj read pr list": expect.any(String),
			"fgj write pr create --title TEXT": expect.any(String),
			"fgj write pr edit <pr>": expect.any(String),
			"fgj write pr close <pr...>": expect.any(String),
			"fgj write pr reopen <pr...>": expect.any(String),
			"fgj destroy pr merge <pr>": expect.any(String),
			"fgj read status get <ref>": expect.any(String),
			"fgj read status wait <ref>": expect.any(String),
			"fgj read run get <run>": expect.any(String),
			"fgj read run log <run>": expect.any(String),
			"fgj read run wait <run>": expect.any(String),
			"fgj write run rerun <run>": expect.any(String),
			"fgj read board list": expect.any(String),
			"fgj read board card <issue...>": expect.any(String),
			"fgj write board create <name>": expect.any(String),
			"fgj write board add <issue...>": expect.any(String),
			"fgj write board move <issue...> --column NAME": expect.any(String),
			"fgj read api get <repo-relative-path>": expect.any(String),
		});
		expect(r.json.exit).toMatchObject({ "2": "usage", "6": "risk_mismatch" });
		expect(r.json.more).toBe("fgj help <noun> <action>");
	});

	test("board create help names choices, default, reuse, refusal, and login", async () => {
		const r = await fgj("help", "board", "create");
		expect(r.code).toBe(0);
		for (const text of [
			"none",
			"basic-kanban",
			"bug-triage",
			"default",
			"open",
			"closed",
			"case",
			"web login",
			"--dry-run",
			"100 characters",
			"255 UTF-8 bytes",
		])
			expect(r.stdout).toContain(text);
	});

	test("the identity text and the auth help state the default rule", async () => {
		const top = (await fgj("help")).json;
		expect(top.identity).toContain("the host's default profile");
		expect(top.identity).toContain("fgj auth default");
		const auth = (await fgj("help", "auth")).json;
		expect(Object.keys(auth.commands)).toContain("fgj auth default <profile>");
		expect(auth.commands["fgj auth default <profile>"]).toMatch(/human/);
		const rules = (await fgj("help", "rules")).json;
		expect(rules.classes).toContain("auth default");
	});

	test("fgj, --help, -h, and --json give the same top level", async () => {
		const top = (await fgj("help")).stdout;
		for (const argv of [[], ["--help"], ["-h"], ["help", "--json"]]) {
			const r = await fgj(...argv);
			expect(r.code).toBe(0);
			expect(r.stdout).toBe(top);
		}
	});

	test("a verb's detail has args, flags with placeholders, output, and examples", async () => {
		const r = await fgj("help", "comment", "add");
		expect(r.code).toBe(0);
		expect(r.json).toMatchObject({
			cmd: "fgj write comment add <issue> --body-file PATH",
			args: { issue: expect.any(String) },
			flags: {
				"--body-file PATH": expect.any(String),
				"--dry-run": expect.any(String),
				"--repo owner/name": expect.any(String),
			},
			output: expect.stringContaining("changed"),
		});
		expect(r.json.examples.length).toBeGreaterThanOrEqual(1);
		expect(r.json.examples.length).toBeLessThanOrEqual(2);
		const list = (await fgj("help", "comment", "list")).json;
		expect(list.fields).toEqual({
			all: [
				"id",
				"author",
				"created_at",
				"updated_at",
				"url",
				"body",
				"attachments",
			],
			default: ["id", "author", "created_at", "body"],
		});
		expect(Object.keys(list.flags)).toContain("--fields a,b");
	});

	test("a verb's notes show in its detail, and a verb with none has no notes key", () => {
		const notes = ["Edits your own comments only."];
		expect(verbHelp({ ...commentAdd, notes } as Verb).notes).toEqual(notes);
		expect(verbHelp(commentAdd as Verb)).not.toHaveProperty("notes");
	});

	test("--help on a verb call prints its detail with no network call", async () => {
		const detail = (await fgj("help", "comment", "list")).stdout;
		const r = await fgj("read", "comment", "list", "--help");
		expect(r.code).toBe(0);
		expect(r.stdout).toBe(detail);
	});

	test("help <noun> lists that noun's verbs", async () => {
		const r = await fgj("help", "comment");
		expect(r.code).toBe(0);
		expect(Object.keys(r.json.verbs)).toEqual([
			"fgj read comment list <issue>",
			"fgj read comment get <comment>",
			"fgj write comment add <issue> --body-file PATH",
			"fgj write comment edit <comment> --body-file PATH",
			"fgj write comment attach <comment> --file PATH",
			"fgj destroy comment delete <comment>",
		]);
	});

	test("an unknown verb names the valid verbs and hints the noun help", async () => {
		const r = await fgj("write", "comment", "pin", "1");
		expect(r.code).toBe(2);
		const err = JSON.parse(r.stderr).error;
		expect(err.message).toContain(
			"Verbs for comment: list, get, add, edit, attach, delete",
		);
		expect(err.hint).toBe("fgj help comment");

		const unknownNoun = JSON.parse((await fgj("help", "wiki")).stderr).error;
		expect(unknownNoun.message).toContain("Nouns: comment");
		expect(unknownNoun.hint).toBe("fgj help");
	});

	test("every verb under every other risk class fails with exit 6 and the right command", async () => {
		for (const verb of MANIFEST) {
			for (const risk of ["read", "write", "destroy"].filter(
				(r) => r !== verb.risk,
			)) {
				const r = await fgj(risk, verb.noun, verb.action, "1");
				const err = JSON.parse(r.stderr).error;
				expect({
					risk,
					verb: verb.action,
					code: r.code,
					hint: err.hint,
				}).toEqual({
					risk,
					verb: verb.action,
					code: 6,
					hint: `fgj ${verb.risk} ${verb.noun} ${verb.action} 1`,
				});
			}
		}
	});

	test("help ignores a leading risk class, as agents often write it", async () => {
		const detail = (await fgj("help", "comment", "delete")).stdout;
		for (const risk of ["read", "write", "destroy"]) {
			const r = await fgj("help", risk, "comment", "delete");
			expect({ risk, code: r.code, same: r.stdout === detail }).toEqual({
				risk,
				code: 0,
				same: true,
			});
		}
		const noun = (await fgj("help", "read", "comment")).stdout;
		expect(noun).toBe((await fgj("help", "comment")).stdout);
		expect((await fgj("help", "read")).stdout).toBe((await fgj("help")).stdout);
		expect((await fgj("help", "read", "--json")).stdout).toBe(
			(await fgj("help")).stdout,
		);
		expect((await fgj("help", "write", "auth")).stdout).toBe(
			(await fgj("help", "auth")).stdout,
		);
	});

	test("usage hints point at the verb help without --json", async () => {
		const r = await fgj("read", "comment", "list");
		expect(JSON.parse(r.stderr).error.hint).toBe("fgj help comment list");
	});
});

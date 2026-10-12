import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { approvalDir } from "../../src/hooks/approval.ts";
import { piExtension } from "../../src/rules/generate.ts";
import {
	piHome,
	runPi,
	runPiRpc,
	type ScriptedCall,
	startFakeModel,
} from "../support/pi-harness.ts";
import { tempDir } from "../support/tmp.ts";

/**
 * Real pi runs with the generated fgj adapter and a scripted model. They
 * prove what unit tests cannot: that pi loads the adapter, that the adapter's
 * bash tool carries the role's profile, and that fgj refuses a destroy that
 * the text gate never saw.
 */

const pi = Bun.which("pi");
const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
/** fgj from source, as the adapter and the scripts in these runs call it. */
const FGJ = [process.execPath, CLI];
const fgjText = FGJ.map((w) => `'${w}'`).join(" ");

/**
 * The `index.js` of an installed pi-subagents package, from `FGJ_PI_SUBAGENTS`,
 * for the parallel-lane test. Without it, that test is skipped.
 */
const SUBAGENTS = process.env.FGJ_PI_SUBAGENTS ?? "";

describe.skipIf(!pi)("the fgj pi adapter in a real pi", () => {
	let model: ReturnType<typeof startFakeModel>;
	beforeAll(() => {
		model = startFakeModel();
	});
	afterAll(() => model.stop());

	/** A pi home, and adapter files: the global form and two role forms. */
	function setup() {
		const home = piHome(model.url);
		const state = tempDir("fgj-pi-state-");
		const approvals = approvalDir({ XDG_STATE_HOME: state });
		const write = (name: string, profile?: string) => {
			const file = join(home, `${name}.ts`);
			writeFileSync(
				file,
				piExtension({
					fgj: FGJ,
					approvals,
					...(profile ? { profile } : {}),
				}),
			);
			return file;
		};
		return {
			home,
			env: { XDG_STATE_HOME: state },
			global: write("fgj-gate"),
			roleA: write("role-a", "role-a"),
			roleB: write("role-b", "role-b"),
		};
	}

	const bash = (command: string): ScriptedCall => ({
		name: "bash",
		arguments: { command },
	});

	test("a role lane's bash calls carry its profile, and the pi process has none", async () => {
		const s = setup();
		const out = await runPi(
			s.home,
			[
				[
					bash(
						'echo profile=$(printenv FGJ_PROFILE || echo none) session=$(test -n "$PI_SESSION_ID" && echo set)',
					),
				],
			],
			[s.roleA],
			s.env,
		);
		expect(out.stdout).toContain("profile=role-a session=set");
		const plain = await runPi(
			s.home,
			[[bash("echo profile=$(printenv FGJ_PROFILE || echo none)")]],
			[s.global],
			s.env,
		);
		expect(plain.stdout).toContain("profile=none");
	}, 60_000);

	test("two fgj adapters in one session stop pi at start", async () => {
		const s = setup();
		const out = await runPi(
			s.home,
			[[bash("true")]],
			[s.global, s.roleA],
			s.env,
		);
		expect(out.code).not.toBe(0);
		expect(out.stderr).toContain('Tool "bash" conflicts');
	}, 60_000);

	test("with no human to ask, a destroy is blocked with the way forward", async () => {
		const s = setup();
		const out = await runPi(
			s.home,
			[[bash("fgj destroy comment delete 5 --dry-run")]],
			[s.roleA],
			s.env,
		);
		expect(out.stdout).toContain("Run each fgj command alone and plain");
	}, 60_000);

	test("a bound lane cannot change its account inline", async () => {
		const s = setup();
		const out = await runPi(
			s.home,
			[[bash("FGJ_PROFILE=team-lead fgj read issue get 5")]],
			[s.roleA],
			s.env,
		);
		expect(out.stdout).toContain("acts as the profile role-a");
	}, 60_000);

	test("a destroy that a script hides from the gate still needs an approval", async () => {
		const s = setup();
		const script = join(s.home, "hidden.sh");
		writeFileSync(
			script,
			`${fgjText} destroy comment delete 5 --dry-run; echo exit=$?\n`,
		);
		const out = await runPi(
			s.home,
			[[bash(`sh ${script}`)]],
			[s.global],
			s.env,
		);
		expect(out.stdout).toContain(
			"In pi, fgj destroy runs only after a human approves",
		);
		expect(out.stdout).toContain("exit=3");
	}, 60_000);

	/** A PATH with an `fgj` shim that runs fgj from source. */
	function shimPath(home: string): string {
		const bin = join(home, "bin");
		mkdirSync(bin, { recursive: true });
		const shim = join(bin, "fgj");
		writeFileSync(shim, `#!/bin/sh\nexec ${fgjText} "$@"\n`);
		chmodSync(shim, 0o755);
		return `${bin}:${process.env.PATH ?? ""}`;
	}

	const DESTROY = "fgj destroy comment delete 5 --dry-run; echo exit=$?";

	test("a human's yes gives the destroy one approval, which fgj accepts and uses up", async () => {
		const s = setup();
		const run = await runPiRpc(s.home, [[bash(DESTROY)]], [s.global], true, {
			...s.env,
			PATH: shimPath(s.home),
		});
		expect(run.confirms).toHaveLength(1);
		expect(run.confirms[0]).toContain("fgj destroy has no undo");
		const out = run.results.join("\n");
		// fgj got past the approval check; it stops later, at the host, because
		// the test home has no git origin.
		expect(out).not.toContain("runs only after a human approves");
		expect(out).toContain("No Forgejo host");
		const dir = approvalDir(s.env);
		expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
	}, 90_000);

	test("a human's no stops the call before it runs", async () => {
		const s = setup();
		const run = await runPiRpc(s.home, [[bash(DESTROY)]], [s.global], false, {
			...s.env,
			PATH: shimPath(s.home),
		});
		expect(run.confirms).toHaveLength(1);
		expect(run.results.join("\n")).not.toContain("exit=");
	}, 90_000);

	test("with a pi shellCommandPrefix, an approved destroy still gets its approval", async () => {
		const s = setup();
		writeFileSync(
			join(s.home, "settings.json"),
			JSON.stringify({ shellCommandPrefix: "export FGJ_TEST_PREFIX=1" }),
		);
		const run = await runPiRpc(
			s.home,
			[[bash(`${DESTROY}; echo prefix=$FGJ_TEST_PREFIX`)]],
			[s.global],
			true,
			{ ...s.env, PATH: shimPath(s.home) },
		);
		const out = run.results.join("\n");
		expect(run.confirms).toHaveLength(1);
		expect(out).toContain("prefix=1");
		expect(out).not.toContain("runs only after a human approves");
		expect(out).toContain("No Forgejo host");
	}, 90_000);

	test.each([
		["never", "global"],
		["always", "project"],
	])(
		"with project trust %s, the bash calls use the %s shellCommandPrefix",
		async (trust, used) => {
			const s = setup();
			mkdirSync(join(s.home, ".pi"), { recursive: true });
			writeFileSync(
				join(s.home, ".pi", "settings.json"),
				JSON.stringify({ shellCommandPrefix: "export FGJ_PREFIX=project" }),
			);
			writeFileSync(
				join(s.home, "settings.json"),
				JSON.stringify({
					defaultProjectTrust: trust,
					shellCommandPrefix: "export FGJ_PREFIX=global",
				}),
			);
			const out = await runPi(
				s.home,
				[[bash("echo prefix=$FGJ_PREFIX")]],
				[s.global],
				s.env,
			);
			expect(out.stdout).toContain(`prefix=${used}`);
		},
		60_000,
	);

	test("a PI_CODING_AGENT_DIR that starts with ~ still gives the agent settings", async () => {
		const s = setup();
		writeFileSync(
			join(s.home, "settings.json"),
			JSON.stringify({ shellCommandPrefix: "export FGJ_PREFIX=global" }),
		);
		const out = await runPi(
			s.home,
			[[bash("echo prefix=$FGJ_PREFIX")]],
			[s.global],
			// The test HOME is the pi home, so ~ names the same folder.
			{ ...s.env, PI_CODING_AGENT_DIR: "~" },
		);
		expect(out.stdout).toContain("prefix=global");
	}, 60_000);

	test.skipIf(!existsSync(SUBAGENTS))(
		"two parallel lanes keep their own profile",
		async () => {
			const s = setup();
			for (const role of ["role-a", "role-b"]) {
				writeFileSync(
					join(s.home, "agents", `${role}.md`),
					`---\nname: ${role}\ndescription: test lane\nmodel: fake/script\ntools: bash\nextensions: ${join(s.home, `${role}.ts`)}\n---\nRun the command.\n`,
				);
			}
			const log = join(s.home, "lanes.txt");
			const task = (role: string) =>
				`STEPS: ${JSON.stringify([[bash(`echo ${role} start=$FGJ_PROFILE >> ${log}; sleep 2; echo ${role} end=$FGJ_PROFILE >> ${log}`)]])}`;
			await runPi(
				s.home,
				[
					[{ name: "subagents_enable", arguments: {} }],
					[
						{
							name: "subagent",
							arguments: { agent: "role-a", task: task("role-a"), async: true },
						},
					],
					[
						{
							name: "subagent",
							arguments: { agent: "role-b", task: task("role-b"), async: true },
						},
					],
					[{ name: "bg_wait", arguments: { all: true, timeoutMs: 60_000 } }],
				],
				[SUBAGENTS],
				s.env,
			);
			expect(existsSync(log)).toBe(true);
			const lines = (await Bun.file(log).text()).trim().split("\n");
			expect([...lines].sort()).toEqual([
				"role-a end=role-a",
				"role-a start=role-a",
				"role-b end=role-b",
				"role-b start=role-b",
			]);
			// The lanes overlapped: both started before either ended.
			const firstEnd = lines.findIndex((l) => l.includes(" end="));
			expect(
				lines.slice(0, firstEnd).filter((l) => l.includes(" start=")),
			).toHaveLength(2);
		},
		90_000,
	);
});

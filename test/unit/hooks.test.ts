import { describe, expect, mock, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { saveProfile } from "../../src/auth/store.ts";
import { main } from "../../src/core/dispatch.ts";
import {
	APPROVAL_TTL_MS,
	approvalDir,
	consumeApproval,
} from "../../src/hooks/approval.ts";
import { type GateAction, gate } from "../../src/hooks/gate.ts";
import { commandsRun, simpleCommands } from "../../src/hooks/shell.ts";
import { piExtension } from "../../src/rules/generate.ts";
import { tempDir } from "../support/tmp.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

type SpawnCtx = {
	command: string;
	cwd: string;
	env: Record<string, string | undefined>;
};
type SpawnHook = (ctx: SpawnCtx) => SpawnCtx;
const registered: { options: { spawnHook: SpawnHook } }[] = [];

mock.module("@earendil-works/pi-coding-agent", () => ({
	createBashTool: (_cwd: string, options: { spawnHook: SpawnHook }) => {
		const tool = { name: "bash", options };
		registered.push(tool);
		return tool;
	},
}));

describe("the gate core", () => {
	test("a bound lane adds its profile to every command, and blocks a command that changes the account", () => {
		const bound = { profile: "team-qa" };
		expect(gate("ls -la", bound)).toEqual({
			action: "pass",
			env: { FGJ_PROFILE: "team-qa" },
		});
		for (const command of [
			"FGJ_PROFILE=team-lead fgj write issue close 5",
			"env FGJ_PROFILE=team-lead fgj read issue get 5",
			"unset FGJ_PROFILE; fgj write issue close 5",
			"env -u FGJ_PROFILE fgj write issue close 5",
		]) {
			const out = gate(command, bound);
			expect({ command, action: out.action }).toEqual({
				command,
				action: "block",
			});
			expect(out.reason).toContain("acts as the profile team-qa");
		}
		// With no binding, an inline profile asks a human (it could reach a bound-only profile).
		expect(gate("FGJ_PROFILE=team-lead fgj read issue get 5").action).toBe(
			"ask",
		);
	});

	test("a lookup of fgj passes, and an ask names the way forward for a headless run", () => {
		for (const command of [
			"which fgj",
			"command -v fgj >/dev/null",
			"type fgj",
		]) {
			expect({ command, action: gate(command).action }).toEqual({
				command,
				action: "pass",
			});
		}
		const ask = gate("fgj destroy comment delete 5");
		expect(ask.action).toBe("ask");
		expect(ask.reason).toContain("Run each fgj command alone and plain");
	});
});

describe("gate regressions", () => {
	test("a lookup of fgj passes only with redirects; a command after it is still gated", () => {
		for (const command of [
			"which fgj && fgj destroy comment delete 5",
			"command -v fgj >/dev/null && fgj auth remove qa",
			"type fgj & fgj auth login",
		]) {
			expect({ command, action: gate(command).action }).toEqual({
				command,
				action: "ask",
			});
		}
		expect(gate("command -v fgj >/dev/null 2>&1").action).toBe("pass");
	});

	test("a bound lane blocks every form that drops or changes its binding", () => {
		const bound = { profile: "team-qa" };
		for (const command of [
			"env --unset=FGJ_PROFILE fgj write issue close 5",
			'env -u "FGJ_PROFILE" fgj write issue close 5',
			'unset FGJ_PRO""FILE; fgj write issue close 5',
			"env -i PATH=/usr/bin fgj write issue close 5",
			"env - fgj write issue close 5",
			"env --ignore-environment fgj write issue close 5",
			"export FGJ_PROFILE=team-lead; fgj write issue close 5",
		]) {
			expect({ command, action: gate(command, bound).action }).toEqual({
				command,
				action: "block",
			});
		}
	});

	test("an unbound call that picks FGJ_PROFILE itself asks a human", () => {
		const out = gate("FGJ_PROFILE=team-qa fgj write issue close 5");
		expect(out.action).toBe("ask");
		expect(out.effects?.join(" ")).toContain("FGJ_PROFILE");
		// Other FGJ_ settings keep a plain call plain.
		expect(gate("FGJ_TRACE=1 fgj read issue get 5").action).toBe("pass");
	});

	test("env rules stay inside one command, and += counts as a change", () => {
		const bound = { profile: "team-qa" };
		for (const command of [
			"env | grep -i fgj",
			"grep -rn process.env -i src/fgj",
			"fgj read issue list --search env -i",
			"grep -r 'env -i' src",
		]) {
			expect({ command, action: gate(command, bound).action }).toEqual({
				command,
				action: "pass",
			});
		}
		for (const command of [
			"  env -i fgj read issue get 5",
			"/usr/bin/env -i fgj read issue get 5",
			"FOO=1 env -i fgj read issue get 5",
			"if true; then env -i fgj read issue get 5; fi",
			"{ env -i fgj read issue get 5; }",
			"echo `env -i fgj read issue get 5`",
			"echo $(env -i fgj read issue get 5)",
			"sudo -E env -i fgj read issue get 5",
			"env -u HOME -i fgj read issue get 5",
			"env -vi fgj read issue get 5",
			"bash -c 'env -i fgj read issue get 5'",
			"true && env - fgj read issue get 5",
		]) {
			expect({ command, action: gate(command, bound).action }).toEqual({
				command,
				action: "block",
			});
		}
	});

	test("quoted text, comments, and heredoc lines about env -i do not block a bound lane", () => {
		const bound = { profile: "team-qa" };
		for (const command of [
			"fgj write issue create --repo a/b --title 'Gate: block `env -i` in bound lanes' --body-file /tmp/x.md",
			"fgj write issue edit 5 --title 'fix(gate) env -i at every position'",
			"fgj read issue list --search '`env -i`'",
			"git commit -m 'the gate blocks `env -i` in a bound lane'",
			'git commit -m "fix(gate) env -i is blocked"',
			"cat <<EOF\n- env -i now blocks\nEOF",
			"echo done # (env -i)",
			"bash script.sh",
			"fgj read issue list --search FGJ_PROFILE",
		]) {
			expect({ command, action: gate(command, bound).action }).toEqual({
				command,
				action: "pass",
			});
		}
	});

	test("heredoc bodies and quoted text about env -i or FGJ_PROFILE do not block a bound lane", () => {
		const bound = { profile: "team-qa" };
		for (const command of [
			"git commit -m \"$(cat <<'EOF'\nfix: the gate blocks `env -i` in a bound lane\n\nCo-Authored-By: Claude\nEOF\n)\"",
			"cat > /tmp/body.md <<'EOF'\nRepro:\n\n    env -i fgj read issue get 5\nunset FGJ_PROFILE\nEOF\nfgj write issue create --repo a/b --title x --body-file /tmp/body.md",
			'cat <<-"END"\n\tenv -i fgj read issue get 5\n\tEND',
			'git commit -m "unset FGJ_PROFILE in the test harness"',
			'fgj write issue create --repo a/b --title "Block FGJ_PROFILE= in bound lanes"',
			"fgj read issue list --search FGJ_PROFILE=x",
		]) {
			expect({ command, action: gate(command, bound).action }).toEqual({
				command,
				action: "pass",
			});
		}
		expect(
			gate(
				'fgj write issue create --repo a/b --title "Block FGJ_PROFILE= here"',
			).action,
		).toBe("pass");
	});

	test("line continuations, heredoc ends, -lc, and split redirects do not hide a binding change", () => {
		const bound = { profile: "team-qa" };
		for (const command of [
			"FGJ_TRACE=1 \\\n  env -i fgj read issue get 5",
			"sudo \\\n env -i fgj read issue get 5",
			"env \\\n  -i fgj read issue get 5",
			"git commit -m \"$(cat <<'EOF'\nfix: it's done\nEOF\n)\" && env -i fgj read issue get 5",
			"cat <<EOF\n$(env -i fgj read issue get 5)\nEOF",
			'bash -lc "env -i fgj read issue get 5"',
			"2> /dev/null env -i fgj read issue get 5",
			"2>&1 env -i fgj read issue get 5",
			"FGJ_PROFILE=other; export FGJ_PROFILE; fgj read issue get 5",
			"sudo FGJ_PROFILE=other fgj read issue get 5",
			"declare -x FGJ_PROFILE=other; fgj read issue get 5",
			"env -uFGJ_PROFILE fgj read issue get 5",
			'jq . <<< "$json"\nenv -i fgj read issue get 5',
			"bash <<'EOF'\nenv -i fgj read issue get 5\nEOF",
			"sudo bash <<EOF\nexport FGJ_PROFILE=other\nfgj read issue get 5\nEOF",
			"export -n FGJ_PROFILE; fgj read issue get 5",
		]) {
			expect({ command, action: gate(command, bound).action }).toEqual({
				command,
				action: "block",
			});
		}
	});

	test("wrappers, redirects, env option values, and case do not hide env -i or a profile read", () => {
		const bound = { profile: "team-qa" };
		for (const command of [
			"timeout 30 env -i fgj read issue get 5",
			"nice env -i fgj read issue get 5",
			'FOO="a b" env -i fgj read issue get 5',
			"2>/dev/null env -i fgj read issue get 5",
			"env -P /usr/bin -i fgj read issue get 5",
			'env -S "-i fgj read issue get 5"',
			"ENV -i fgj read issue get 5",
			'sh -c "cd /tmp; env -i fgj read issue get 5"',
			'echo "$(env -i fgj read issue get 5)"',
			"read FGJ_PROFILE <<< other; fgj read issue get 5",
			"printf -v FGJ_PROFILE other; fgj read issue get 5",
		]) {
			expect({ command, action: gate(command, bound).action }).toEqual({
				command,
				action: "block",
			});
		}
		expect(gate("FGJ_PROFILE+=x fgj read issue get 5", bound).action).toBe(
			"block",
		);
		expect(gate("FGJ_PROFILE+=x fgj read issue get 5").action).toBe("ask");
	});

	test("with no human to answer, an inline FGJ_PROFILE names the problem", () => {
		expect(gate("FGJ_PROFILE=team-qa fgj read issue get 5").reason).toContain(
			"Remove FGJ_PROFILE",
		);
	});

	test("only a destroy gets an approval token", () => {
		expect(gate("fgj destroy comment delete 5").approval).toBe(true);
		expect(gate("fgj auth remove qa").approval).toBeUndefined();
	});
});

describe("the gate judges only commands that run fgj", () => {
	const bound = { profile: "team-qa" };
	const expectAll = (
		commands: string[],
		action: GateAction,
		binding?: { profile: string },
	) => {
		for (const command of commands) {
			expect({ command, action: gate(command, binding).action }).toEqual({
				command,
				action,
			});
		}
	};

	test("a path, a glob, quoted text, or a heredoc that mentions fgj or destroy passes", () => {
		expectAll(
			[
				"cat /home/dev/fgj/README.md | head",
				"ls /home/dev/fgj/src/*.ts",
				"cat ~/.config/fgj/hosts.json",
				"diff -ru agent/skills/claude-skills/fgj agent/skills/fgj || true",
				"grep -rn destroy src/*.ts",
				"cat > /tmp/notes.md <<'EOF'\nThe storm will destroy $5 of crops in *every* field.\nEOF",
				'git commit -m "fgj destroy asks now"',
				"rg -n 'fgj auth login' docs",
			],
			"pass",
		);
	});

	test("a [ or [[ test that compares with destroy or auth passes", () => {
		expectAll(
			[
				'[ "$1" = destroy ] && echo yes',
				'if [ "$cmd" = "destroy" ]; then terraform destroy; fi',
				"[[ $action == auth ]] && echo x",
			],
			"pass",
		);
		expect(gate("~/bin/f[g]j destroy comment delete 5").action).toBe("ask");
	});

	test("a long word of [ with no ] stays fast", () => {
		const start = performance.now();
		gate(`${"[".repeat(100_000)} destroy`);
		gate(`fgj ${"[".repeat(100_000)}`);
		expect(performance.now() - start).toBeLessThan(500);
	});

	test("many -exec words in one command stay fast", () => {
		const start = performance.now();
		gate(`find . ${"-exec find ".repeat(40)}fgj destroy comment delete 5`);
		expect(performance.now() - start).toBeLessThan(500);
	});

	test("an fgj call in a wrong grammar passes, because fgj refuses it itself", () => {
		expectAll(
			[
				"fgj pr show 234 --repo a/b",
				"fgj status checks --ref abc",
				"fgj comment --help && fgj pr --help",
				"which fgj 2>/dev/null; fgj --help 2>&1 | head -60",
			],
			"pass",
		);
	});

	test("a real or hidden destroy or auth call still asks", () => {
		expectAll(
			[
				"fgj destroy comment delete 5",
				"x=fgj; $x destroy comment delete 5",
				"~/bin/fg? destroy comment delete 5",
				"`echo fgj` destroy comment delete 5",
				"/usr/local/bin/fgj destroy comment delete 5",
				"fgj $(echo destroy) comment delete 5",
				"fgj {read,destroy} comment delete 5",
				"env fgj destroy comment delete 5",
				"find . -name x -exec fgj destroy comment delete {} \\;",
				"cd /tmp && FGJ destroy comment delete 5",
				"fgj auth login",
			],
			"ask",
		);
	});

	test("a bound lane blocks a binding change only in a command that runs fgj", () => {
		expectAll(
			[
				"env -i python3 x.py",
				"unset FGJ_PROFILE; ls",
				"FGJ_PROFILE=other make build",
			],
			"pass",
			bound,
		);
		expectAll(
			[
				"env -i fgj read issue get 5",
				"unset FGJ_PROFILE; fgj read issue get 5",
				"FGJ_PROFILE=other fgj read issue get 5",
			],
			"block",
			bound,
		);
		expect(gate("FGJ_PROFILE=other make build").action).toBe("pass");
	});
});

describe("approvals", () => {
	const home = () => tempDir("fgj-approve-");
	const issue = (env: Record<string, string>, expires: number) => {
		const token = crypto.randomUUID();
		mkdirSync(approvalDir(env), { recursive: true });
		writeFileSync(join(approvalDir(env), token), JSON.stringify({ expires }));
		return token;
	};

	test("a fresh approval works once, and its file is gone after use", () => {
		const env = { HOME: home() };
		const now = Date.now();
		const token = issue(env, now + APPROVAL_TTL_MS);
		const call = { ...env, FGJ_APPROVAL: token };
		expect(consumeApproval(call, now)).toBe(true);
		expect(existsSync(join(approvalDir(env), token))).toBe(false);
		expect(consumeApproval(call, now)).toBe(false);
	});

	test("an expired approval file goes away on the next check", () => {
		const env = { HOME: home() };
		const now = Date.now();
		const old = issue(env, now - 1);
		expect(consumeApproval(env, now)).toBe(false);
		expect(existsSync(join(approvalDir(env), old))).toBe(false);
	});

	test("an expired, forged, missing, or odd-shaped token fails", () => {
		const env = { HOME: home() };
		const now = Date.now();
		const old = issue(env, now - 1);
		expect(consumeApproval({ ...env, FGJ_APPROVAL: old }, now)).toBe(false);
		expect(
			consumeApproval({ ...env, FGJ_APPROVAL: crypto.randomUUID() }, now),
		).toBe(false);
		expect(consumeApproval(env, now)).toBe(false);
		expect(consumeApproval({ ...env, FGJ_APPROVAL: "../x" }, now)).toBe(false);
	});
});

describe("the pi adapter", () => {
	type Handler = (
		event: { toolName: string; input: { command?: string } },
		ctx: unknown,
	) => Promise<{ block?: boolean; reason?: string } | undefined>;

	/** Loads a generated adapter, and returns its handler and bash spawnHook. */
	async function load(options: { profile?: string; fgj?: string[] } = {}) {
		const dir = tempDir("fgj-adapter-");
		const approvals = approvalDir({ XDG_STATE_HOME: dir });
		const file = join(dir, "fgj-gate.ts");
		await Bun.write(
			file,
			piExtension({
				fgj: options.fgj ?? [process.execPath, CLI],
				approvals,
				...(options.profile ? { profile: options.profile } : {}),
			}),
		);
		const mod = await import(file);
		let handler: Handler | undefined;
		mod.default({
			on: (event: string, h: Handler) => {
				if (event === "tool_call") handler = h;
			},
			registerTool: () => {},
		});
		const tool = registered[registered.length - 1];
		if (!handler || !tool) throw new Error("the adapter registered nothing");
		return { handler, spawn: tool.options.spawnHook, approvals, state: dir };
	}

	const yes = {
		hasUI: true,
		isProjectTrusted: () => false,
		ui: { confirm: async () => true },
	};
	const bash = (command: string) => ({ toolName: "bash", input: { command } });
	const spawn = (hook: SpawnHook, command: string) =>
		hook({ command, cwd: "/", env: { PATH: "/bin" } }).env;

	test("the role form adds its profile to every bash call; the global form adds none", async () => {
		const role = await load({ profile: "team-qa" });
		expect(spawn(role.spawn, "ls").FGJ_PROFILE).toBe("team-qa");
		const global = await load();
		expect(spawn(global.spawn, "ls").FGJ_PROFILE).toBeUndefined();
	});

	test("an approved call gets one token; a sibling and a repeat get none", async () => {
		const { handler, spawn: hook, approvals, state } = await load();
		const command = "fgj destroy comment delete 5";
		expect(await handler(bash(command), yes)).toBeUndefined();
		expect(spawn(hook, "echo sibling").FGJ_APPROVAL).toBeUndefined();
		const token = spawn(hook, command).FGJ_APPROVAL;
		expect(token).toMatch(/^[0-9a-f-]{36}$/);
		expect(readdirSync(approvals)).toEqual([token as string]);
		expect(spawn(hook, command).FGJ_APPROVAL).toBeUndefined();
		// fgj accepts that token once, and refuses a reuse.
		const env = { XDG_STATE_HOME: state, FGJ_APPROVAL: token };
		expect(consumeApproval(env, Date.now())).toBe(true);
		expect(consumeApproval(env, Date.now())).toBe(false);
	});

	test("a declined call gets no token", async () => {
		const { handler, spawn: hook } = await load();
		const command = "fgj destroy comment delete 5";
		const no = {
			hasUI: true,
			isProjectTrusted: () => false,
			ui: { confirm: async () => false },
		};
		expect(await handler(bash(command), no)).toMatchObject({ block: true });
		expect(spawn(hook, command).FGJ_APPROVAL).toBeUndefined();
	});

	test("a bound lane blocks an inline profile change through fgj hook", async () => {
		const { handler } = await load({ profile: "team-qa" });
		const out = await handler(
			bash("FGJ_PROFILE=team-lead fgj write issue close 5"),
			yes,
		);
		expect(out).toMatchObject({ block: true });
		expect(out?.reason).toContain("acts as the profile team-qa");
	});

	test("a name hidden by quotes or backslashes still reaches the gate", async () => {
		const { handler } = await load();
		for (const command of [
			"f\\gj auth remove qa",
			'"f"gj auth default qa',
			"f\\gj de\\stroy comment delete 5",
		]) {
			let asked = 0;
			const ctx = {
				hasUI: true,
				isProjectTrusted: () => false,
				ui: {
					confirm: async () => {
						asked++;
						return false;
					},
				},
			};
			expect({ command, out: await handler(bash(command), ctx) }).toMatchObject(
				{
					command,
					out: { block: true },
				},
			);
			expect({ command, asked }).toEqual({ command, asked: 1 });
		}
	});

	test("an approved call that is not a destroy writes no approval file", async () => {
		const { handler, spawn: hook, approvals } = await load();
		const command = "fgj auth remove qa";
		expect(await handler(bash(command), yes)).toBeUndefined();
		expect(spawn(hook, command).FGJ_APPROVAL).toBeUndefined();
		expect(existsSync(approvals)).toBe(false);
	});

	test("a broken fgj fails closed: every call that reaches fgj is blocked", async () => {
		const { handler } = await load({ fgj: ["/nonexistent/fgj"] });
		const out = await handler(bash("fgj read issue get 5"), yes);
		expect(out).toMatchObject({ block: true });
		expect(out?.reason).toContain("fgj hook pi failed");
		// A command that cannot reach fgj still runs.
		expect(await handler(bash("ls -la"), yes)).toBeUndefined();
	});
});

describe("fgj hook and rules edges", () => {
	/** Runs fgj in-process with a temp home. */
	async function fgj(argv: string[], env: Record<string, string> = {}) {
		let stdout = "";
		let stderr = "";
		const home = tempDir("fgj-edges-");
		const code = await main(argv, {
			cwd: home,
			env: { HOME: home, PI_CODING_AGENT_DIR: join(home, "pi"), ...env },
			stdout: (t) => {
				stdout += t;
			},
			stderr: (t) => {
				stderr += t;
			},
		});
		return { code, stdout, stderr, home };
	}

	test("a usage error in pi keeps the approval for the corrected call", async () => {
		const state = tempDir("fgj-state-");
		const env = { XDG_STATE_HOME: state };
		const token = crypto.randomUUID();
		mkdirSync(approvalDir(env), { recursive: true });
		writeFileSync(
			join(approvalDir(env), token),
			JSON.stringify({ expires: Date.now() + APPROVAL_TTL_MS }),
		);
		const out = await fgj(["destroy", "comment", "delete"], {
			...env,
			PI_SESSION_ID: "s1",
			FGJ_APPROVAL: token,
		});
		expect(out.code).toBe(2);
		expect(existsSync(join(approvalDir(env), token))).toBe(true);
	});

	test("a destroy that pi runs with no approval is refused and goes to the audit log", async () => {
		const state = tempDir("fgj-state-");
		const argv = ["destroy", "comment", "delete", "5", "--repo", "a/b"];
		const out = await fgj(argv, {
			XDG_STATE_HOME: state,
			PI_SESSION_ID: "s1",
			FGJ_PROFILE: "team-qa",
		});
		expect(out.code).toBe(3);
		const lines = (await Bun.file(join(state, "fgj", "audit.jsonl")).text())
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines).toEqual([
			expect.objectContaining({ as: "team-qa", argv, error: "auth" }),
		]);
	});

	test("the audit line for an unapproved pi destroy hides stored tokens and keeps the --as it asked for", async () => {
		const home = tempDir("fgj-store-");
		const state = tempDir("fgj-state-");
		const token = "synthetic-write-token-for-audit-test";
		await saveProfile({ HOME: home }, "qa", {
			host: "https://a.example",
			user: "qa-bot",
			read: "r-stored-secret-000001",
			write: token,
		});
		const out = await fgj(
			[
				"destroy",
				"comment",
				"delete",
				"5",
				"--repo",
				`a/${token}`,
				"--as",
				"qa",
			],
			{ HOME: home, XDG_STATE_HOME: state, PI_SESSION_ID: "s1" },
		);
		expect(out.code).toBe(3);
		const text = await Bun.file(join(state, "fgj", "audit.jsonl")).text();
		expect(text).not.toContain(token);
		expect(JSON.parse(text.trim())).toMatchObject({
			attempted: "qa",
			error: "auth",
		});
	});

	test("fgj hook --help shows the hook help, and rules show --role fails for codex", async () => {
		const help = await fgj(["hook", "--help"]);
		expect(help.code).toBe(0);
		expect(JSON.parse(help.stdout).commands["fgj hook pi"]).toBeDefined();
		const show = await fgj(["rules", "show", "codex", "--role", "a=b"]);
		expect(show.code).toBe(2);
		expect(show.stderr).toContain("Only pi takes --role");
	});

	test("rules status skips a directory named like a role file", async () => {
		const home = tempDir("fgj-roles-");
		mkdirSync(join(home, "pi", "fgj-roles", "odd.ts"), { recursive: true });
		let stdout = "";
		const code = await main(["rules", "status"], {
			cwd: home,
			env: { HOME: home, PI_CODING_AGENT_DIR: join(home, "pi") },
			stdout: (t) => {
				stdout += t;
			},
			stderr: () => {},
		});
		expect(code).toBe(0);
		const pi = JSON.parse(stdout).harnesses.find(
			(h: { harness: string }) => h.harness === "pi",
		);
		expect(pi.roles).toBeUndefined();
	});

	test("rules status shows a role file that is a symlink", async () => {
		const home = tempDir("fgj-roles-");
		const roles = join(home, "pi", "fgj-roles");
		mkdirSync(roles, { recursive: true });
		writeFileSync(join(home, "kept.ts"), "");
		symlinkSync(join(home, "kept.ts"), join(roles, "linked.ts"));
		let stdout = "";
		await main(["rules", "status"], {
			cwd: home,
			env: { HOME: home, PI_CODING_AGENT_DIR: join(home, "pi") },
			stdout: (t) => {
				stdout += t;
			},
			stderr: () => {},
		});
		const pi = JSON.parse(stdout).harnesses.find(
			(h: { harness: string }) => h.harness === "pi",
		);
		expect(pi.roles).toMatchObject([{ role: "linked", state: "outdated" }]);
	});

	test("the hook help names every field of the decision", async () => {
		const help = JSON.parse((await fgj(["hook", "--help"])).stdout);
		expect(help.commands["fgj hook pi"]).toContain("approval");
	});
});

describe("the shell reader", () => {
	test("a $(…) inside double quotes is its own command, and the quoted word marks where it was", () => {
		expect(simpleCommands('echo "a $(b "c d") e"; f')).toEqual([
			["b", "c d"],
			["echo", "a $(…) e"],
			["f"],
		]);
	});

	test("parentheses inside a $(…) do not end it", () => {
		expect(simpleCommands("x $( (a) ; b ) y")).toEqual([
			["a"],
			["b"],
			["x", "$(…)", "y"],
		]);
	});

	test("a shell's -c string and env's command count as the commands they run", () => {
		expect(
			commandsRun("A=1 sudo -E bash -lc 'cd /tmp && ENV -i ls'").map(
				(r) => r.words,
			),
		).toEqual([
			["bash", "-lc", "cd /tmp && ENV -i ls"],
			["cd", "/tmp"],
			["env", "-i", "ls"],
			["ls"],
		]);
		expect(commandsRun("A=1 B+=2")).toEqual([
			{ words: [], assigns: ["A=1", "B+=2"] },
		]);
	});

	test("an arithmetic << is a shift, not a heredoc", () => {
		expect(simpleCommands("echo $((1<<2))\nenv -i ls")).toEqual([
			["echo", "$((1<<2))"],
			["env", "-i", "ls"],
		]);
	});
});

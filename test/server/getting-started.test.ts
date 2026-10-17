import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	createIssue,
	createRepo,
	expectOk,
	loadServer,
} from "../support/forgejo.ts";
import { cleanEnv, tempDir } from "../support/tmp.ts";

const ROOT = join(import.meta.dir, "../..");
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

async function terminal(
	command: string,
	env: Record<string, string>,
	answers: [string, string][],
) {
	const inner =
		process.platform === "linux"
			? `cat | script -q -e -c ${quote(command)} /dev/null`
			: `cat | script -q /dev/null ${command}`;
	const proc = Bun.spawn(["sh", "-c", inner], {
		cwd: env.HOME as string,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let screen = "";
	const pump = (async () => {
		for await (const bytes of proc.stdout)
			screen += new TextDecoder().decode(bytes);
	})();
	try {
		for (const [prompt, answer] of answers) {
			const deadline = Date.now() + 15_000;
			while (!screen.includes(prompt)) {
				if (Date.now() > deadline)
					throw new Error(
						`The documented command did not reach the expected prompt: ${prompt}`,
					);
				await Bun.sleep(20);
			}
			proc.stdin.write(`${answer}\r`);
			await proc.stdin.flush();
		}
		const deadline = Date.now() + 15_000;
		while (!screen.includes('"changed":true') && Date.now() < deadline)
			await Bun.sleep(20);
		proc.stdin.end();
		const code = await Promise.race([
			proc.exited,
			Bun.sleep(15_000).then(() => -1),
		]);
		expect(
			code,
			"The documented terminal command must finish successfully.",
		).toBe(0);
		await pump;
		return screen;
	} finally {
		proc.kill();
		await proc.exited;
	}
}

function installNative(tarball: string, home: string): string {
	const checksum =
		readFileSync(`${tarball}.sha256`, "utf8").split(/\s+/)[0] ?? "";
	expect(checksum).toMatch(/^[a-f0-9]{64}$/);
	expect(createHash("sha256").update(readFileSync(tarball)).digest("hex")).toBe(
		checksum,
	);
	const extracted = join(home, "candidate");
	mkdirSync(extracted);
	const result = Bun.spawnSync(["tar", "-xzf", tarball, "-C", extracted]);
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	const bin = join(home, "bin");
	mkdirSync(bin);
	// Only system tools needed by the terminal and Git are available to fgj.
	for (const tool of ["sh", "cat", "script", "git"])
		symlinkSync(Bun.which(tool) as string, join(bin, tool));
	for (const runtime of ["bun", "node", "npm"])
		expect(Bun.which(runtime, { PATH: bin })).toBeNull();
	const previous = process.env.FGJ_NATIVE_PREVIOUS_TARBALL;
	if (previous) {
		const old = join(home, "previous");
		mkdirSync(old);
		expect(Bun.spawnSync(["tar", "-xzf", previous, "-C", old]).exitCode).toBe(
			0,
		);
		copyFileSync(join(old, "fgj"), join(bin, "fgj"));
		const oldVersion = Bun.spawnSync([join(bin, "fgj"), "version"], {
			env: { ...cleanEnv(home), PATH: bin },
		});
		expect(oldVersion.exitCode).toBe(0);
		const newVersion = Bun.spawnSync([join(extracted, "fgj"), "version"], {
			env: { ...cleanEnv(home), PATH: bin },
		});
		expect(newVersion.exitCode).toBe(0);
		expect(oldVersion.stdout.toString()).not.toBe(newVersion.stdout.toString());
	}
	copyFileSync(join(extracted, "fgj"), join(bin, "fgj.next"));
	renameSync(join(bin, "fgj.next"), join(bin, "fgj"));
	expect(
		createHash("sha256")
			.update(readFileSync(join(bin, "fgj")))
			.digest("hex"),
	).toBe(
		createHash("sha256")
			.update(readFileSync(join(extracted, "fgj")))
			.digest("hex"),
	);
	return bin;
}

test("the README user commands check startup, authenticate, configure a harness and read the intended repository", async () => {
	const server = await loadServer();
	const repo = await createRepo(server);
	await createIssue(server, repo, "Getting started smoke");
	const source = readFileSync(join(ROOT, "README.md"), "utf8")
		.split("<!-- getting-started:start -->")[1]
		?.split("<!-- getting-started:end -->")[0] as string;
	const blocks = [...source.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) =>
		(match[1] as string)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	);
	expect(blocks).toHaveLength(5);
	let tarball = process.env.FGJ_PACKAGE_TARBALL;
	if (!tarball && !process.env.FGJ_NATIVE_TARBALL) {
		const packed = Bun.spawnSync([process.execPath, "scripts/package.ts"], {
			cwd: ROOT,
		});
		expect(packed.exitCode).toBe(0);
		tarball = JSON.parse(packed.stdout.toString().trim()).tarball;
	}
	for (const harness of [
		"claude",
		"codex",
		...(process.env.FGJ_NATIVE_TARBALL ? ["pi"] : []),
	]) {
		const home = join(
			tempDir(`fgj-start-${harness}-`),
			"directory with spaces",
		);
		const install = join(home, ".bun");
		mkdirSync(join(install, "bin"), { recursive: true });
		const env = {
			...cleanEnv(home),
			TMPDIR: home,
			BUN_INSTALL: install,
			BUN_INSTALL_CACHE_DIR: join(home, "cache"),
			PATH: `${install}/bin:${process.env.PATH ?? ""}`,
		};
		if (process.env.FGJ_NATIVE_TARBALL) {
			env.PATH = installNative(process.env.FGJ_NATIVE_TARBALL, home);
			writeFileSync(join(home, ".env"), "FGJ_PROFILE=hostile\n");
			writeFileSync(
				join(home, "preload.ts"),
				'throw new Error("hostile preload ran");\n',
			);
			writeFileSync(join(home, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
			writeFileSync(join(home, ".bunfig.toml"), 'preload = ["./preload.ts"]\n');
		} else {
			copyFileSync(tarball as string, join(home, "fgj-0.1.0.tgz"));
			for (const command of [
				'bun add --global --ignore-scripts "$PWD/fgj-0.1.0.tgz"',
				"bun pm bin -g",
			]) {
				const result = Bun.spawnSync(["sh", "-ec", command as string], {
					cwd: home,
					env,
				});
				expect(
					result.exitCode,
					`The fixture ${harness} installation must succeed.`,
				).toBe(0);
			}
			expect(Bun.which("fgj", { PATH: env.PATH })).toBe(
				join(install, "bin/fgj"),
			);
		}
		for (const command of blocks[0] ?? []) {
			const result = Bun.spawnSync(["sh", "-ec", command], { cwd: home, env });
			expect(
				result.exitCode,
				"The documented startup commands must succeed.",
			).toBe(0);
		}
		const auth = String(blocks[1]?.[0]).replace(
			"https://your-forgejo.example",
			server.url,
		);
		const screen = await terminal(auth, env, [
			["Read token (input hidden): ", server.readToken],
			["Write token (input hidden): ", server.writeToken],
			["the default for", "y"],
		]);
		expect(
			screen.includes(server.readToken) || screen.includes(server.writeToken),
			"The terminal must not echo either token.",
		).toBe(false);
		for (const block of [blocks[2], blocks[3]]) {
			await terminal(String(block?.[0]).replace("claude", harness), env, [
				["[y/N]", "y"],
			]);
		}
		if (process.env.FGJ_NATIVE_TARBALL && harness === "pi") {
			const adapter = readFileSync(
				join(home, ".pi/agent/extensions/fgj-gate.ts"),
				"utf8",
			);
			const callback = JSON.parse(
				/^const FGJ: string\[\] = (.+);$/m.exec(adapter)?.[1] ?? "null",
			) as string[];
			expect(callback).toEqual([realpathSync(join(home, "bin/fgj"))]);
			const replay = Bun.spawnSync([...callback, "auth", "status"], {
				cwd: home,
				env,
			});
			expect(replay.exitCode, replay.stderr.toString()).toBe(0);
			expect(replay.stdout.toString()).not.toContain("hostile");
			for (const [command, action] of [
				["fgj read issue get 1", "pass"],
				["fgj destroy comment delete 1", "ask"],
			]) {
				const hook = Bun.spawnSync([...callback, "hook", "pi"], {
					cwd: home,
					env,
					stdin: Buffer.from(JSON.stringify({ command })),
				});
				expect(hook.exitCode, hook.stderr.toString()).toBe(0);
				expect(JSON.parse(hook.stdout.toString()).action).toBe(action);
			}
		}
		const firstRead = String(blocks[4]?.[0]).replace(
			"owner/repository",
			`${repo.owner}/${repo.name}`,
		);
		const startedAt = new Date().toISOString();
		const result = Bun.spawnSync(["sh", "-ec", firstRead], { cwd: home, env });
		const output = await expectOk<{ as: string; items: { title: string }[] }>({
			argv: firstRead.split(" "),
			code: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
			trace: "",
			startedAt,
		});
		expect(output.as).toBe("agent");
		expect(
			output.items.some((item) => item.title === "Getting started smoke"),
		).toBe(true);
		for (const command of [
			"fgj auth status",
			"fgj rules status",
			"fgj skill status",
			"fgj help auth",
			"fgj help rules",
			"fgj help skill",
		]) {
			expect(
				Bun.spawnSync(["sh", "-ec", command], { cwd: home, env }).exitCode,
			).toBe(0);
		}
	}
}, 120_000);

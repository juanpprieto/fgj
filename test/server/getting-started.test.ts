import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
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

test("the README user commands install, authenticate, configure a harness and read the intended repository", async () => {
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
	if (!tarball) {
		const packed = Bun.spawnSync([process.execPath, "scripts/package.ts"], {
			cwd: ROOT,
		});
		expect(packed.exitCode).toBe(0);
		tarball = JSON.parse(packed.stdout.toString().trim()).tarball;
	}
	for (const harness of ["claude", "codex"]) {
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
		copyFileSync(tarball as string, join(home, "fgj-0.1.0.tgz"));
		for (const command of [blocks[0]?.[0], "bun pm bin -g", blocks[0]?.[1]]) {
			const result = Bun.spawnSync(["sh", "-ec", command as string], {
				cwd: home,
				env,
			});
			expect(
				result.exitCode,
				`The documented ${harness} installation command must succeed.`,
			).toBe(0);
		}
		expect(Bun.which("fgj", { PATH: env.PATH })).toBe(join(install, "bin/fgj"));
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

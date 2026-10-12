import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv, tempDir } from "./tmp.ts";

/**
 * Real pi runs for tests, with no model provider. A scripted OpenAI-compatible
 * model answers pi: the first user message holds `STEPS: [[calls], …]`, and
 * each model turn returns the next list of tool calls. After the last step,
 * the model answers `OUT: <tool results>`.
 */

/** One scripted tool call. */
export interface ScriptedCall {
	name: string;
	arguments: unknown;
}

type Message = { role: string; content?: unknown };

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				typeof part === "object" && part && "text" in part
					? String(part.text)
					: "",
			)
			.join("");
	}
	return "";
}

const CHUNK = {
	id: "fake",
	object: "chat.completion.chunk",
	created: 0,
	model: "script",
};

function stream(chunks: object[]): Response {
	const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

/**
 * Starts the scripted model in this process, on a free port.
 *
 * @returns The base URL for pi's `models.json`, and a stop function.
 * @example
 * const model = startFakeModel(); // model.url is "http://127.0.0.1:<port>/v1"
 */
export function startFakeModel(): { url: string; stop: () => void } {
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as { messages: Message[] };
			const first = body.messages.find((m) => m.role === "user");
			const script = /STEPS:\s*([\s\S]+)$/.exec(text(first?.content));
			const turn = body.messages.filter((m) => m.role === "assistant").length;
			const calls = script
				? (JSON.parse(script[1] as string) as ScriptedCall[][])[turn]
				: undefined;
			if (calls) {
				return stream([
					{
						...CHUNK,
						choices: [
							{
								index: 0,
								delta: {
									role: "assistant",
									tool_calls: calls.map((c, i) => ({
										index: i,
										id: `call_${turn}_${i}`,
										type: "function",
										function: {
											name: c.name,
											arguments: JSON.stringify(c.arguments),
										},
									})),
								},
								finish_reason: null,
							},
						],
					},
					{
						...CHUNK,
						choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
					},
				]);
			}
			const last = body.messages.map((m) => m.role).lastIndexOf("assistant");
			const results = body.messages
				.slice(last + 1)
				.filter((m) => m.role === "tool")
				.map((m) => text(m.content));
			return stream([
				{
					...CHUNK,
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								content: `OUT: ${results.join(" | ")}`,
							},
							finish_reason: null,
						},
					],
				},
				{
					...CHUNK,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
			]);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		stop: () => server.stop(true),
	};
}

/**
 * Makes a pi home with the scripted model as its only provider, so a run never
 * reads the user's pi settings, extensions, or credentials.
 *
 * @param modelUrl - The scripted model's base URL.
 * @returns The pi home directory.
 * @example
 * const home = piHome(model.url);
 */
export function piHome(modelUrl: string): string {
	const home = tempDir("fgj-pi-");
	mkdirSync(join(home, "agents"), { recursive: true });
	writeFileSync(
		join(home, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: modelUrl,
					api: "openai-completions",
					apiKey: "fake",
					models: [{ id: "script" }],
				},
			},
		}),
	);
	return home;
}

/**
 * Runs pi once in print mode with the scripted model.
 *
 * @param home - The pi home from {@link piHome}.
 * @param steps - The tool calls for each model turn.
 * @param extensions - Extension files to load with `-e`.
 * @param env - Env values for pi and its bash calls.
 * @returns The final text, stderr, and the exit code.
 * @example
 * await runPi(home, [[{ name: "bash", arguments: { command: "ls" } }]], [adapter]);
 */
export async function runPi(
	home: string,
	steps: ScriptedCall[][],
	extensions: readonly string[],
	env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn(
		[
			"pi",
			"-p",
			"--model",
			"fake/script",
			...extensions.flatMap((e) => ["-e", e]),
			`STEPS: ${JSON.stringify(steps)}`,
		],
		{
			cwd: home,
			env: {
				...cleanEnv(home),
				// pi writes caches (jiti, pi-subagents results) to TMPDIR; this one goes
				// away with the other temporary directories after the run.
				TMPDIR: tempDir("fgj-pi-tmp-"),
				PI_CODING_AGENT_DIR: home,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
				...env,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	// A hung pi still stops, so it does not outlive the test.
	const timer = setTimeout(() => proc.kill(), 60_000);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, code };
	} finally {
		clearTimeout(timer);
	}
}

/** What an RPC run of pi showed. */
export interface RpcRun {
	/** The message of each approval dialog, in order. */
	confirms: string[];
	/** The text of each tool result, in order. */
	results: string[];
}

/**
 * Runs pi once in RPC mode with the scripted model, and answers each approval
 * dialog, as a human at a terminal would.
 *
 * @param home - The pi home from {@link piHome}.
 * @param steps - The tool calls for each model turn.
 * @param extensions - Extension files to load with `-e`.
 * @param answer - The answer to every approval dialog.
 * @param env - Env values for pi and its bash calls.
 * @returns The dialog messages and the tool results.
 * @example
 * const run = await runPiRpc(home, steps, [adapter], true);
 */
export async function runPiRpc(
	home: string,
	steps: ScriptedCall[][],
	extensions: readonly string[],
	answer: boolean,
	env: Record<string, string> = {},
): Promise<RpcRun> {
	const proc = Bun.spawn(
		[
			"pi",
			"--mode",
			"rpc",
			"--model",
			"fake/script",
			...extensions.flatMap((e) => ["-e", e]),
		],
		{
			cwd: home,
			env: {
				...cleanEnv(home),
				TMPDIR: tempDir("fgj-pi-tmp-"),
				PI_CODING_AGENT_DIR: home,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
				...env,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		},
	);
	const send = (message: object) => {
		proc.stdin.write(`${JSON.stringify(message)}\n`);
		proc.stdin.flush();
	};
	const run: RpcRun = { confirms: [], results: [] };
	send({
		id: "p1",
		type: "prompt",
		message: `STEPS: ${JSON.stringify(steps)}`,
	});
	const decoder = new TextDecoder();
	let buffer = "";
	// A hung pi still stops, so it does not outlive the test: the kill ends
	// stdout, and the loop.
	const timer = setTimeout(() => proc.kill(), 60_000);
	try {
		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let at = buffer.indexOf("\n");
			let settled = false;
			while (at >= 0) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				at = buffer.indexOf("\n");
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				if (
					event.type === "extension_ui_request" &&
					event.method === "confirm"
				) {
					run.confirms.push(String(event.message));
					send({
						type: "extension_ui_response",
						id: event.id,
						confirmed: answer,
					});
				}
				if (event.type === "tool_execution_end") {
					run.results.push(JSON.stringify(event.result ?? ""));
				}
				if (event.type === "agent_settled") settled = true;
			}
			if (settled) break;
		}
	} finally {
		clearTimeout(timer);
		proc.stdin.end();
		proc.kill();
		await proc.exited;
	}
	return run;
}

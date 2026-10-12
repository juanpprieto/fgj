import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/core/dispatch.ts";
import { FgjError } from "../../src/core/errors.ts";
import { OUTPUT_CAP } from "../../src/core/output.ts";
import { commentAttach, fitAttachmentTexts } from "../../src/verbs/comment.ts";
import { tempDir } from "../support/tmp.ts";

/** Runs fgj in-process with no host or token, so only local checks can answer. */
async function fgj(cwd: string, ...argv: string[]) {
	let stderr = "";
	const code = await main(argv, {
		cwd,
		env: {},
		stdout: () => {},
		stderr: (t) => {
			stderr += t;
		},
	});
	return { code, error: stderr ? JSON.parse(stderr).error : undefined };
}

describe("comment attach: local checks before any request", () => {
	const dir = tempDir("fgj-attach-");
	const put = (name: string, data: string | Uint8Array) => {
		writeFileSync(join(dir, name), data);
		return name;
	};
	const attach = (...argv: string[]) =>
		fgj(dir, "write", "comment", "attach", ...argv);

	test("a missing comment or --file is a usage error", async () => {
		for (const argv of [["--file", put("a.md", "a\n")], ["770"]]) {
			const r = await attach(...argv);
			expect({ argv, code: r.code }).toEqual({ argv, code: 2 });
			expect(r.error.message).not.toContain("Unknown verb");
		}
	});

	test("a file that is missing, empty, binary, not UTF-8, or over 1 MiB is refused", async () => {
		const cases: Record<string, string> = {
			"gone.md": "Cannot read",
			[put("empty.md", " \n")]: "empty",
			[put("nul.log", "a\0b")]: "binary",
			[put("latin1.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9]))]: "UTF-8",
			[put("big.log", "x".repeat(1024 * 1024 + 1))]: "1048576",
		};
		for (const [name, words] of Object.entries(cases)) {
			const r = await attach("770", "--file", name);
			expect({ name, code: r.code }).toEqual({ name, code: 2 });
			expect(r.error.message).toContain(words);
		}
	});

	test("a valid text file passes the local checks and stops only at the missing host", async () => {
		const r = await attach("770", "--file", put("ok.md", "Evidence.\n"));
		expect(r.error.message).toContain("No Forgejo host");
	});
});

/** A fake write client: one own comment, no attachments, and the given settings. */
function fakeApi(settings: Record<string, unknown>) {
	const sent: string[] = [];
	const api = {
		sent,
		send: async (method: string, path: string) => {
			sent.push(`${method} ${path}`);
			if (path === "/user") return { login: "me" };
			return { id: 770, user: { login: "me" }, issue_url: "x/issues/1" };
		},
		get: async (path: string) => {
			sent.push(`GET ${path}`);
			if (path === "/settings/attachment") return settings;
			return [];
		},
		upload: async () => {
			sent.push("UPLOAD");
			return {};
		},
		assertSendable: () => {},
	};
	return api;
}

const ctx = (api: unknown) =>
	({
		target: { owner: "o", name: "r", baseUrl: "https://x.test" },
		api,
		commandWith: () => "",
		commandFor: () => "",
	}) as never;

const input = {
	ref: { id: 770, canonical: "770" },
	file: { name: "e.md", text: "Evidence.\n", size: 10 },
	dryRun: false,
};

describe("comment attach: instance settings", () => {
	test("the type list reads , and | separators, any case, */*, and an empty list", async () => {
		const cases: [string, boolean][] = [
			[".PNG|.MD", true],
			[".png, .md", true],
			["*/*", true],
			["", true],
			[".png|.txt", false],
		];
		for (const [types, uploads] of cases) {
			const api = fakeApi({ enabled: true, allowed_types: types, max_size: 4 });
			await commentAttach.run(input as never, ctx(api)).catch(() => undefined);
			expect({ types, uploads: api.sent.includes("UPLOAD") }).toEqual({
				types,
				uploads,
			});
		}
	});

	test("a 422 from the server, when it decides the type, is a usage error that names the file", async () => {
		const api = {
			...fakeApi({ enabled: true, allowed_types: "text/*", max_size: 4 }),
			upload: async () => {
				throw new FgjError(
					"api",
					"POST …/assets: not allowed",
					"fgj help",
					422,
				);
			},
		};
		const err = await commentAttach.run(input as never, ctx(api)).then(
			() => undefined,
			(e: FgjError) => e,
		);
		expect(err?.code).toBe("usage");
		expect(err?.message).toContain("e.md");
	});

	test("attachments that the instance disables give a clear error, and nothing is sent", async () => {
		const api = fakeApi({ enabled: false, allowed_types: "", max_size: 4 });
		const err = await commentAttach.run(input as never, ctx(api)).then(
			() => undefined,
			(e: FgjError) => e,
		);
		expect(err?.code).toBe("conflict");
		expect(err?.message).toContain("disabled");
		expect(api.sent).not.toContain("UPLOAD");
	});

	test("a MIME entry in allowed_types lets the server decide on the type", async () => {
		const api = fakeApi({
			enabled: true,
			allowed_types: ".png,text/*",
			max_size: 4,
		});
		await commentAttach.run(input as never, ctx(api));
		expect(api.sent).toContain("UPLOAD");
	});

	test("an extension-only list refuses a file whose extension it does not hold", async () => {
		const api = fakeApi({
			enabled: true,
			allowed_types: ".png,.txt",
			max_size: 4,
		});
		const err = await commentAttach.run(input as never, ctx(api)).then(
			() => undefined,
			(e: FgjError) => e,
		);
		expect(err?.code).toBe("usage");
		expect(err?.message).toContain(".md");
		expect(api.sent).not.toContain("UPLOAD");
	});
});

describe("comment get: attachment texts fit the output", () => {
	test("large texts share the budget, the body stays whole, and a binary file gets no text", () => {
		const item = { id: 1, issue: 2, author: "a", body: "b".repeat(5000) };
		const files = [
			...Array.from({ length: 4 }, (_, i) => ({
				name: `log${i}.txt`,
				size: 8000,
				content_type: "text/plain; charset=utf-8",
				text: `"\n${"x".repeat(7998)}`,
			})),
			{ name: "shot.png", size: 900, content_type: "image/png" },
		];
		const shown = fitAttachmentTexts(item, files);
		const line = JSON.stringify({ ...item, attachments: shown, as: "env" });
		expect(line.length).toBeLessThanOrEqual(OUTPUT_CAP);
		expect(item.body).toHaveLength(5000);
		for (const f of shown.slice(0, 4)) {
			expect(f).toMatchObject({ text_truncated: true, text_chars: 8000 });
		}
		expect(shown[4]).toEqual({
			name: "shot.png",
			size: 900,
			content_type: "image/png",
		});
	});

	test("small texts stay whole", () => {
		const shown = fitAttachmentTexts({ id: 1 }, [
			{ name: "a.md", size: 3, content_type: "text/markdown", text: "Hi\n" },
		]);
		expect(shown).toEqual([
			{ name: "a.md", size: 3, content_type: "text/markdown", text: "Hi\n" },
		]);
	});
});

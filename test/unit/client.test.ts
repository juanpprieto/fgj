import { afterAll, describe, expect, test } from "bun:test";
import { createRedactor } from "../../src/core/redact.ts";
import { createTracer } from "../../src/core/trace.ts";
import { ReadApi } from "../../src/forgejo/client.ts";

// A tiny local server that answers with the exact status and body each path names.
const server = Bun.serve({
	port: 0,
	fetch(req) {
		const path = new URL(req.url).pathname;
		if (path.endsWith("/redirect")) {
			return new Response(null, {
				status: 301,
				headers: { location: "/elsewhere" },
			});
		}
		if (path.endsWith("/locked")) {
			return Response.json({ message: "repo is archived" }, { status: 423 });
		}
		if (path.endsWith("/reason")) {
			return Response.json(
				{
					message: "The target couldn't be found.",
					errors: ["comment does not exist [id: 9, issue_id: 0]\nmore"],
				},
				{ status: 404 },
			);
		}
		if (path.endsWith("/multiline")) {
			return Response.json(
				{ message: "first line\nsecond line with detail\nthird" },
				{ status: 404 },
			);
		}
		if (path.endsWith("/mergeconflict")) {
			// Forgejo 16's answer to a rebase that conflicts: no message field.
			return Response.json(
				{
					Style: "rebase",
					CommitSHA: "a".repeat(40),
					StdOut:
						"Auto-merging f.txt\nCONFLICT (content): Merge conflict in f.txt\n",
					StdErr:
						"Rebasing (1/2)\rerror: could not apply aaaaaaa... b\nhint: Resolve all conflicts manually\n",
					Err: { Stderr: null },
				},
				{ status: 409 },
			);
		}
		if (path.endsWith("/text")) {
			return new Response("42", { headers: { "content-type": "text/plain" } });
		}
		seen.push(path);
		return Response.json({ ok: true });
	},
});

/** Every path that reached the default handler. */
const seen: string[] = [];
afterAll(() => server.stop());

const api = new ReadApi(
	`http://127.0.0.1:${server.port}`,
	"token-for-tests-0000",
	createTracer({}, () => {}, createRedactor()),
);

describe("client error mapping", () => {
	test("423 (archived or locked) is a conflict", async () => {
		await expect(api.get("/repos/o/r/locked")).rejects.toMatchObject({
			code: "conflict",
			exitCode: 5,
		});
	});

	test("a server message keeps its first line only", async () => {
		const err = (await api
			.get("/repos/o/r/multiline")
			.catch((e: unknown) => e)) as Error;
		expect(err.message).toContain("first line");
		expect(err.message).not.toContain("second line");
	});
});

describe("server reasons", () => {
	test("a merge conflict names the style and git's conflict line, not the raw JSON", async () => {
		const err = (await api
			.get("/repos/o/r/mergeconflict")
			.catch((e: unknown) => e)) as Error;
		expect(err.message).toContain(
			"rebase conflict: CONFLICT (content): Merge conflict in f.txt",
		);
		expect(err.message).not.toContain("StdOut");
	});

	test("a 404 message adds the first line of Forgejo's first error", async () => {
		const err = (await api
			.get("/repos/o/r/reason")
			.catch((e: unknown) => e)) as Error;
		expect(err.message).toContain(
			"The target couldn't be found. (comment does not exist [id: 9, issue_id: 0])",
		);
		expect(err.message).not.toContain("more");
	});
});

describe("redirects", () => {
	test("a redirect is an error, so a POST never turns into a GET", async () => {
		await expect(api.get("/repos/o/r/redirect")).rejects.toMatchObject({
			code: "api",
			message: expect.stringContaining("redirect"),
		});
	});
});

describe("paths that URL parsing would change", () => {
	test("a dot segment fails before any request, so no verb leaves its repository", async () => {
		for (const path of [
			"/repos/../user",
			"/repos/o/r/../../user",
			"/repos/x/./r",
			"/repos/o/r/%2F..%2Fx",
			"/repos/o/r/%5c..%5cx",
		]) {
			const before = seen.length;
			await expect(api.get(path)).rejects.toMatchObject({ code: "usage" });
			expect({ path, sent: seen.length - before }).toEqual({ path, sent: 0 });
		}
	});
});

describe("getPaged", () => {
	test("a text body fails even when it parses as JSON", async () => {
		await expect(api.getPaged("/repos/o/r/text")).rejects.toMatchObject({
			code: "usage",
		});
	});
});

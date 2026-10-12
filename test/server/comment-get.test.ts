import { beforeAll, describe, expect, test } from "bun:test";
import {
	addComment,
	createIssue,
	createRepo,
	expectError,
	expectOk,
	type FixtureRepo,
	httpCalls,
	loadServer,
	makeWorkDir,
	onlyGets,
	runFgj,
	type TestServer,
} from "../support/forgejo.ts";

interface Got {
	id: number;
	issue: number;
	author: string;
	body: string;
	body_truncated?: true;
	body_chars?: number;
	note?: string;
	as: string;
}

describe("fgj read comment get", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;
	let issue: number;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		cwd = await makeWorkDir(server, repo);
		issue = await createIssue(server, repo, "Keep a living list");
	}, 60_000);

	const get = (dir: string, ...rest: string[]) =>
		runFgj(server, ["read", "comment", "get", ...rest], dir);

	test("returns id, issue, author, and the whole body past the list default, in one GET", async () => {
		const body = `- [ ] item\n${"x".repeat(6000)}`;
		const id = await addComment(server, repo, issue, body);
		const result = await get(cwd, String(id));
		const out = await expectOk<Got>(result);
		expect(out).toEqual({
			id,
			issue,
			author: server.username,
			body,
			as: "env",
		});
		expect(httpCalls(result)).toEqual([
			`GET /repos/${repo.owner}/${repo.name}/issues/comments/${id}`,
		]);
	});

	test("a comment URL names the repository, with no git origin", async () => {
		const id = await addComment(server, repo, issue, "From a URL.");
		const url = `${server.url}/${repo.owner}/${repo.name}/issues/${issue}#issuecomment-${id}`;
		const out = await expectOk<Got>(await get(await makeWorkDir(server), url));
		expect(out).toMatchObject({ id, issue, body: "From a URL." });
	});

	test("--fields picks fields, and --fields alone lists them", async () => {
		const id = await addComment(server, repo, issue, "Pick me.");
		const out = await expectOk<Record<string, unknown>>(
			await get(cwd, String(id), "--fields", "id,updated_at,url"),
		);
		expect(Object.keys(out).sort()).toEqual(["as", "id", "updated_at", "url"]);
		expect(String(out.url)).toEndWith(`#issuecomment-${id}`);
		const fields = await expectOk<{ fields: string[] }>(
			await get(cwd, String(id), "--fields"),
		);
		expect(fields.fields).toContain("created_at");
	});

	test("a body over the 20000-character limit is cut, and a note warns against editing from it", async () => {
		const body = "y".repeat(21_000);
		const id = await addComment(server, repo, issue, body);
		const out = await expectOk<Got>(await get(cwd, String(id)));
		expect(out.body_truncated).toBe(true);
		expect(out.body_chars).toBe(21_000);
		expect(Array.from(out.body).length).toBeLessThanOrEqual(20_000);
		expect(out.note).toMatch(/do not edit/i);
	});

	test("a comment URL whose issue number does not match fails with usage", async () => {
		const id = await addComment(server, repo, issue, "On the first issue.");
		const url = `${server.url}/${repo.owner}/${repo.name}/issues/999#issuecomment-${id}`;
		const err = await expectError(await get(cwd, url), "usage", 2);
		expect(err.message).toContain(`issue ${issue}`);
	});

	test("an event id is a usage error for get, edit, and delete, and nothing changes", async () => {
		const closing = await createIssue(server, repo, "Closed for an event");
		const auth = `Basic ${btoa(`${server.username}:${server.password}`)}`;
		const base = `${server.url}/api/v1/repos/${repo.owner}/${repo.name}/issues/${closing}`;
		await fetch(base, {
			method: "PATCH",
			headers: { authorization: auth, "content-type": "application/json" },
			body: JSON.stringify({ state: "closed" }),
		});
		const timeline = (await (
			await fetch(`${base}/timeline`, { headers: { authorization: auth } })
		).json()) as { id: number; type: string }[];
		const event = timeline.find((e) => e.type === "close");
		expect(event).toBeDefined();
		const id = String(event?.id);
		const file = `${cwd}/event.md`;
		await Bun.write(file, "x");
		for (const argv of [
			["read", "comment", "get", id],
			["write", "comment", "edit", id, "--body-file", file],
			["destroy", "comment", "delete", id],
			["destroy", "comment", "delete", id, "--dry-run"],
		]) {
			const result = await runFgj(server, argv, cwd);
			const err = await expectError(result, "usage", 2);
			expect(err.message).toContain("plain issue comments");
			expect(onlyGets(result)).toBe(true);
		}
	});

	test("a missing comment fails with not_found", async () => {
		const err = await expectError(await get(cwd, "999999999"), "not_found", 4);
		expect(err.hint).toBe("fgj help comment get");
	});
});

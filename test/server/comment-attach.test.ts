import { beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	adminApi,
	createIssue,
	createRepo,
	createUser,
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

interface Asset {
	id: number;
	name: string;
	size: number;
	browser_download_url: string;
}

describe("fgj write comment attach", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;
	let issue: number;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		cwd = await makeWorkDir(server, repo);
		issue = await createIssue(server, repo, "Evidence");
	}, 60_000);

	/** Posts a comment on the issue, as the caller unless a login is given. */
	const comment = async (login?: { username: string; password: string }) =>
		(
			await adminApi<{ id: number }>(
				server,
				`/repos/${repo.owner}/${repo.name}/issues/${issue}/comments`,
				{ body: "Evidence follows." },
				login,
			)
		).id;

	const assets = (id: number) =>
		adminApi<Asset[]>(
			server,
			`/repos/${repo.owner}/${repo.name}/issues/comments/${id}/assets`,
		);

	/** Writes a file in the work dir and returns its name. */
	const file = (name: string, text: string) => {
		writeFileSync(join(cwd, name), text);
		return name;
	};

	const attach = (id: number, ...argv: string[]) =>
		runFgj(server, ["write", "comment", "attach", String(id), ...argv], cwd);

	test("uploads a text file to your own comment and returns its download URL", async () => {
		const id = await comment();
		const name = file("evidence.md", "# Evidence\n\nAll checks passed.\n");
		const out = await expectOk<Record<string, unknown>>(
			await attach(id, "--file", name),
		);
		const [stored] = await assets(id);
		expect(stored).toMatchObject({ name: "evidence.md", size: 31 });
		expect(out).toEqual({
			changed: true,
			id: stored?.id,
			comment: id,
			name: "evidence.md",
			size: 31,
			url: stored?.browser_download_url,
			as: "env",
		});
		expect(String(out.url)).toContain("/attachments/");
	});

	test("comment get shows the attachments, with their text on request, and comment list only with --fields", async () => {
		const id = await comment();
		const text = "Shown evidence.\nLine 2.\n";
		await expectOk(await attach(id, "--file", file("shown.md", text)));
		const want = [{ name: "shown.md", size: text.length }];
		const get = (...extra: string[]) =>
			runFgj(server, ["read", "comment", "get", String(id), ...extra], cwd);
		const got = await expectOk<Record<string, unknown>>(await get());
		expect(got.attachments).toEqual(want);
		// The text comes through fgj's token: an agent cannot open the download URL.
		const withText = await expectOk<Record<string, unknown>>(
			await get("--attachment-text"),
		);
		expect(withText.attachments).toEqual([
			{ ...want[0], content_type: "text/plain", text },
		]);
		const list = (...extra: string[]) =>
			runFgj(server, ["read", "comment", "list", String(issue), ...extra], cwd);
		const plain = await expectOk<{ items: Record<string, unknown>[] }>(
			await list(),
		);
		expect(plain.items.find((c) => c.id === id)).not.toHaveProperty(
			"attachments",
		);
		const withFiles = await expectOk<{ items: Record<string, unknown>[] }>(
			await list("--fields", "id,attachments"),
		);
		expect(withFiles.items.find((c) => c.id === id)?.attachments).toEqual(want);
	});

	test("--attachment-text gives a binary file its content type and no text", async () => {
		const id = await comment();
		// The smallest PNG header: fgj never shows its bytes as text.
		const png = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
			0x44, 0x52,
		]);
		const form = new FormData();
		form.append(
			"attachment",
			new Blob([png], { type: "image/png" }),
			"shot.png",
		);
		const res = await fetch(
			`${server.url}/api/v1/repos/${repo.owner}/${repo.name}/issues/comments/${id}/assets`,
			{
				method: "POST",
				headers: {
					authorization: `Basic ${btoa(`${server.username}:${server.password}`)}`,
				},
				body: form,
			},
		);
		expect(res.status).toBe(201);
		const got = await expectOk<Record<string, unknown>>(
			await runFgj(
				server,
				["read", "comment", "get", String(id), "--attachment-text"],
				cwd,
			),
		);
		expect(got.attachments).toEqual([
			{ name: "shot.png", size: png.length, content_type: "image/png" },
		]);
	});

	test("the same file again returns changed:false with the existing attachment, and uploads nothing", async () => {
		const id = await comment();
		const name = file("log.txt", "line 1\nline 2\n");
		const first = await expectOk<{ id: number }>(
			await attach(id, "--file", name),
		);
		const again = await attach(id, "--file", name);
		expect(await expectOk<Record<string, unknown>>(again)).toMatchObject({
			changed: false,
			id: first.id,
			name: "log.txt",
		});
		expect(onlyGets(again)).toBe(true);
		expect(await assets(id)).toHaveLength(1);
	});

	test("--dry-run uploads nothing and gives the apply command", async () => {
		const id = await comment();
		const name = file("plan.md", "Plan.\n");
		const result = await attach(id, "--file", name, "--dry-run");
		expect(await expectOk<Record<string, unknown>>(result)).toEqual({
			dry_run: true,
			changed: true,
			comment: id,
			name: "plan.md",
			size: 6,
			apply: `fgj write comment attach ${id} --file plan.md`,
			as: "env",
		});
		expect(onlyGets(result)).toBe(true);
		expect(await assets(id)).toEqual([]);
	});

	test("another author's comment is a conflict, and nothing is uploaded", async () => {
		// The repository is public, so another user can comment on its issue.
		const bob = await createUser(server);
		const id = await comment(bob);
		const result = await attach(id, "--file", file("x.md", "x\n"));
		await expectError(result, "conflict", 5);
		expect(onlyGets(result)).toBe(true);
		expect(await assets(id)).toEqual([]);
	});

	test("a file type that the instance does not allow is refused before the upload", async () => {
		const id = await comment();
		const result = await attach(
			id,
			"--file",
			file("script.ts", "export {};\n"),
		);
		const err = await expectError(result, "usage", 2);
		expect(err.message).toContain(".ts");
		expect(onlyGets(result)).toBe(true);
		expect(await assets(id)).toEqual([]);
	});

	test("a comment that does not exist is not_found", async () => {
		await expectError(
			await attach(999_999, "--file", file("y.md", "y\n")),
			"not_found",
			4,
		);
	});

	test("a file that holds a known token is refused, never sent, and never shown", async () => {
		const id = await comment();
		const name = file("leaked.md", `leaked: ${server.writeToken}\n`);
		for (const extra of [[], ["--dry-run"]]) {
			const result = await attach(id, "--file", name, ...extra);
			const err = await expectError(result, "usage", 2);
			expect(err.message).toContain("holds a stored or env token");
			expect(httpCalls(result).some((c) => c.startsWith("POST"))).toBe(false);
			expect(result.stderr + result.trace).not.toContain(server.writeToken);
		}
		expect(await assets(id)).toEqual([]);
	});

	test("a name with spaces, quotes, and accents is stored as written, so a repeat uploads nothing", async () => {
		const id = await comment();
		const name = file('run "1" résumé.md', "Resume.\n");
		const first = await expectOk<{ name: string }>(
			await attach(id, "--file", name),
		);
		expect(first.name).toBe(name);
		const again = await attach(id, "--file", name);
		expect(await expectOk<Record<string, unknown>>(again)).toMatchObject({
			changed: false,
			name,
		});
		expect(onlyGets(again)).toBe(true);
		const stored = await assets(id);
		expect(stored.map((a) => a.name)).toEqual([name]);
	});

	test("a write token without write:issue fails with auth, and nothing is uploaded", async () => {
		const id = await comment();
		const result = await runFgj(
			server,
			["write", "comment", "attach", String(id), "--file", file("z.md", "z\n")],
			cwd,
			{ FGJ_WRITE_TOKEN: server.readToken },
		);
		await expectError(result, "auth", 3);
		// The reads pass with read scopes; the upload is what the server refuses.
		expect(
			httpCalls(result).some(
				(c) => c.startsWith("POST") && c.includes("/assets"),
			),
		).toBe(true);
		expect(await assets(id)).toEqual([]);
	});
});

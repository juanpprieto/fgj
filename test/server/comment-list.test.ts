import { beforeAll, describe, expect, test } from "bun:test";
import {
	addComment,
	createIssue,
	createRepo,
	createUser,
	deleteUser,
	expectError,
	expectOk,
	type FixtureRepo,
	httpCalls,
	type Login,
	loadServer,
	makeWorkDir,
	runFgj,
	type TestServer,
} from "../support/forgejo.ts";

interface Comment {
	id?: number;
	author?: string;
	body?: string;
	body_truncated?: true;
	body_chars?: number;
}

interface CommentPage {
	items: Comment[];
	total: number;
	next: string | null;
	hint?: string;
	as?: string;
}

/** Splits a `next` or `hint` command into the argv after `fgj`. */
const argvOf = (command: string) => command.split(" ").slice(1);

describe("fgj read comment list", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let slug: string;
	let issue: number;
	let empty: number;
	let ids: number[];

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		slug = `${repo.owner}/${repo.name}`;
		issue = await createIssue(server, repo, "Pick the comment output shape");
		ids = [];
		for (const body of ["first", "second", "third"]) {
			ids.push(await addComment(server, repo, issue, body));
		}
		empty = await createIssue(server, repo, "No comments yet");
	}, 60_000);

	const list = (cwd: string, ...rest: string[]) =>
		runFgj(server, ["read", "comment", "list", ...rest], cwd);

	test("lists comments with author names and no noise keys", async () => {
		const cwd = await makeWorkDir(server, repo);
		const out = await expectOk<CommentPage>(await list(cwd, String(issue)));

		expect(out.total).toBe(3);
		expect(out.next).toBeNull();
		expect(Object.keys(out).sort()).toEqual(["as", "items", "next", "total"]);
		expect(Object.keys(out.items[0] ?? {}).sort()).toEqual([
			"author",
			"body",
			"created_at",
			"id",
		]);
		expect(out.items.map((c) => c.id)).toEqual(ids);
		expect(out.items[0]).toMatchObject({
			author: server.username,
			body: "first",
		});
	});

	test("--fields alone lists the fields with no request", async () => {
		const cwd = await makeWorkDir(server, repo);
		const r = await list(cwd, String(issue), "--fields");
		const out = await expectOk<{ fields: string[]; default: string[] }>(r);
		expect(out.fields).toContain("updated_at");
		expect(out.default).toEqual(["id", "author", "created_at", "body"]);
		expect(httpCalls(r)).toEqual([]);
	});

	test("pages with --limit and gives the exact next command", async () => {
		const cwd = await makeWorkDir(server, repo);
		const page1 = await expectOk<CommentPage>(
			await list(cwd, String(issue), "--limit", "2"),
		);
		expect(page1.items).toHaveLength(2);
		expect(page1.next).toBe(
			`fgj read comment list ${issue} --limit 2 --offset 2`,
		);

		const page2 = await expectOk<CommentPage>(
			await runFgj(server, argvOf(page1.next ?? ""), cwd),
		);
		expect(page2.items.map((c) => c.body)).toEqual(["third"]);
		expect(page2.next).toBeNull();
	});

	test("--last gives the latest comments, oldest first", async () => {
		const cwd = await makeWorkDir(server, repo);
		const out = await expectOk<CommentPage>(
			await list(cwd, String(issue), "--last", "2"),
		);
		expect(out.items.map((c) => c.body)).toEqual(["second", "third"]);
		expect(out.total).toBe(3);
		expect(out.next).toBeNull();
	});

	test("an issue with no comments and an offset past the end are empty pages", async () => {
		const cwd = await makeWorkDir(server, repo);
		expect(await expectOk<CommentPage>(await list(cwd, String(empty)))).toEqual(
			{
				items: [],
				total: 0,
				next: null,
				as: "env",
			},
		);
		expect(
			await expectOk<CommentPage>(
				await list(cwd, String(issue), "--offset", "99"),
			),
		).toEqual({ items: [], total: 3, next: null, as: "env" });
	});

	test("--repo works outside a git work tree and repeats in next", async () => {
		const cwd = await makeWorkDir(server);
		const out = await expectOk<CommentPage>(
			await list(cwd, String(issue), "--limit", "1", "--repo", slug),
		);
		expect(out.items).toHaveLength(1);
		expect(out.next).toBe(
			`fgj read comment list ${issue} --limit 1 --offset 1 --repo ${slug}`,
		);
	});

	test("a GitHub origin is skipped: --repo reaches the Forgejo host", async () => {
		const cwd = await makeWorkDir(server, "git@github.com:acme/app.git");
		const out = await expectOk<CommentPage>(
			await list(cwd, String(issue), "--repo", slug),
		);
		expect(out.total).toBe(3);
		const noRepo = await expectError(
			await list(cwd, String(issue)),
			"usage",
			2,
		);
		expect(noRepo.message).toContain("github.com is not a stored Forgejo host");
	});

	test("accepts #N and an issue URL; next uses the canonical form", async () => {
		const cwd = await makeWorkDir(server);
		const hash = await expectOk<CommentPage>(
			await list(cwd, `#${issue}`, "--limit", "1", "--repo", slug),
		);
		expect(hash.next).toBe(
			`fgj read comment list ${issue} --limit 1 --offset 1 --repo ${slug}`,
		);

		const url = `${server.url}/${slug}/issues/${issue}#issuecomment-${ids[0]}`;
		const byUrl = await expectOk<CommentPage>(
			await list(cwd, url, "--limit=1", "--json"),
		);
		expect(byUrl.items[0]?.id).toBe(ids[0]);
		expect(byUrl.next).toBe(
			`fgj read comment list ${server.url}/${slug}/issues/${issue} --limit 1 --offset 1`,
		);
	});

	test("cuts a long body by characters and hints the full read", async () => {
		const long = await createIssue(server, repo, "Long decision");
		const body = `${"😀".repeat(10)}${"x".repeat(4990)}`;
		await addComment(server, repo, long, body);
		const cwd = await makeWorkDir(server, repo);

		const out = await expectOk<CommentPage>(await list(cwd, String(long)));
		const [c] = out.items;
		expect(c?.body_truncated).toBe(true);
		expect(c?.body_chars).toBe(5000);
		expect(Array.from(c?.body ?? "")).toHaveLength(4000);
		expect(out.hint).toBe(
			`fgj read comment list ${long} --limit 1 --offset 0 --body-max 20000`,
		);

		const full = await expectOk<CommentPage>(
			await runFgj(server, argvOf(out.hint ?? ""), cwd),
		);
		expect(full.items[0]?.body).toBe(body);
		expect(full.items[0]?.body_truncated).toBeUndefined();
	});

	test("a body over the 20000-character limit has no looping hint", async () => {
		const huge = await createIssue(server, repo, "Huge body");
		await addComment(server, repo, huge, "z".repeat(25_000));
		const cwd = await makeWorkDir(server, repo);
		const first = await expectOk<CommentPage & { note?: string }>(
			await list(cwd, String(huge)),
		);
		expect(first.hint).toBeDefined();
		const full = await expectOk<CommentPage & { note?: string }>(
			await runFgj(server, argvOf(first.hint ?? ""), cwd),
		);
		expect(full.items[0]?.body_chars).toBe(25_000);
		expect(full.hint).toBeUndefined();
		expect(full.note).toContain("longer than 20000 characters");
	});

	test("a body full of JSON-escaped characters still fits under the cap", async () => {
		const escaped = await createIssue(server, repo, "Escaped body");
		await addComment(server, repo, escaped, "\\".repeat(19_000));
		const cwd = await makeWorkDir(server, repo);
		const result = await list(cwd, String(escaped), "--body-max", "20000");
		expect(result.stdout.length).toBeLessThan(28_000);
		const out = await expectOk<CommentPage>(result);
		expect(out.items[0]?.body_truncated).toBe(true);
		expect(out.items[0]?.body_chars).toBe(19_000);
	});

	test("stops a page before the output cap and pages the rest exactly", async () => {
		const big = await createIssue(server, repo, "Many long comments");
		const bigIds: number[] = [];
		for (let i = 0; i < 8; i++) {
			bigIds.push(
				await addComment(server, repo, big, `${i}:${"y".repeat(6000)}`),
			);
		}
		const cwd = await makeWorkDir(server, repo);
		const seen: number[] = [];
		let command: string | null =
			`fgj read comment list ${big} --body-max 6000 --fields id,body`;
		let pages = 0;
		while (command) {
			const result = await runFgj(server, argvOf(command), cwd);
			expect(result.stdout.length).toBeLessThan(28_000);
			const out: CommentPage = await expectOk<CommentPage>(result);
			seen.push(...out.items.map((c) => c.id as number));
			command = out.next;
			pages++;
		}
		expect(pages).toBeGreaterThan(1);
		expect(seen).toEqual(bigIds);
	});

	test("errors: missing issue, bad token, unreachable host", async () => {
		const cwd = await makeWorkDir(server, repo);
		const missing = await expectError(await list(cwd, "9999"), "not_found", 4);
		expect(missing.message).toContain(`/issues/9999/comments`);
		expect(missing.hint).toBe("fgj help comment list");

		const badToken = "synthetic-invalid-token-for-comment-list";
		const denied = await list(cwd, String(issue), "--repo", slug);
		const auth = await runFgj(server, denied.argv, cwd, {
			FGJ_READ_TOKEN: badToken,
		});
		const err = await expectError(auth, "auth", 3);
		expect(err.hint).toBe("fgj auth status");
		// Forgejo echoes the token in its error; fgj must not.
		expect(auth.stderr + auth.trace).not.toContain(badToken);

		const down = await runFgj(
			server,
			["read", "comment", "list", "1", "--repo", slug],
			await makeWorkDir(server),
			{ FGJ_URL: "http://127.0.0.1:1" },
		);
		expect((await expectError(down, "api", 1)).hint).toBe("fgj auth status");
	});

	test("a deleted user's comments show the Ghost author", async () => {
		const ghostIssue = await createIssue(server, repo, "Ghost author");
		const carol = await createUser(server);
		await addComment(server, repo, ghostIssue, "from carol", carol);
		await deleteUser(server, carol.username);
		const cwd = await makeWorkDir(server, repo);
		const out = await expectOk<CommentPage>(
			await list(cwd, String(ghostIssue)),
		);
		expect(out.items[0]).toMatchObject({ author: "Ghost", body: "from carol" });
	});

	test("--author and --contains filter before paging, so total and next count only matches", async () => {
		const thread = await createIssue(server, repo, "Filters");
		const bob = await createUser(server);
		const me: Login = server;
		const posts: [string, Login][] = [
			["## Work list\n- [ ] a", me],
			["LGTM", bob],
			["note one", me],
			["Is this the WORK LIST?", bob],
			["note two", me],
		];
		const made: number[] = [];
		for (const [body, login] of posts) {
			made.push(await addComment(server, repo, thread, body, login));
		}
		const cwd = await makeWorkDir(server, repo);
		const idsOf = async (...flags: string[]) => {
			const out = await expectOk<CommentPage>(
				await list(cwd, String(thread), "--fields", "id", ...flags),
			);
			return {
				ids: out.items.map((c) => c.id),
				total: out.total,
				next: out.next,
			};
		};

		const mine = await idsOf("--author", me.username.toUpperCase());
		expect(mine).toEqual({
			ids: [made[0], made[2], made[4]],
			total: 3,
			next: null,
		});
		expect((await idsOf("--contains", "work list")).ids).toEqual([
			made[0],
			made[3],
		]);
		expect(
			(await idsOf("--author", me.username, "--contains", "work list")).ids,
		).toEqual([made[0]]);

		const first = await idsOf("--author", me.username, "--limit", "1");
		expect(first).toMatchObject({ ids: [made[0]], total: 3 });
		expect(first.next).toContain(`--author ${me.username}`);
		const second = await expectOk<CommentPage>(
			await runFgj(server, argvOf(String(first.next)), cwd),
		);
		expect(second.items.map((c) => c.id)).toEqual([made[2]]);

		const phrase = await idsOf("--contains", "note", "--limit", "1");
		expect(phrase.next).toContain("--contains note");
		const spaced = await idsOf("--contains", "note two", "--limit", "1");
		expect(spaced).toMatchObject({ ids: [made[4]], total: 1 });

		const none = await idsOf("--author", "nobody");
		expect(none).toEqual({ ids: [], total: 0, next: null });
	});

	test("an empty --contains or --author is a usage error with no request", async () => {
		const cwd = await makeWorkDir(server, repo);
		for (const flag of ["--contains", "--author"]) {
			const result = await list(cwd, String(issue), `${flag}=`);
			await expectError(result, "usage", 2);
			expect(httpCalls(result)).toEqual([]);
		}
	});
});

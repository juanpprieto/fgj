import { beforeAll, describe, expect, test } from "bun:test";
import { gate } from "../../src/hooks/gate.ts";
import { commandsRun } from "../../src/hooks/shell.ts";
import {
	addComment,
	addPull,
	createIssue,
	createPull,
	expectError,
	expectOk,
	type FixtureRepo,
	httpCalls,
	loadServer,
	makeWorkDir,
	onlyGets,
	runFgj,
	type TestServer,
	webProfile,
} from "../support/forgejo.ts";

interface Part {
	body: string;
	body_next?: string;
	body_offset?: number;
	body_chars?: number;
	body_revision?: string;
	body_truncated?: true;
	discussion?: string;
	id?: number;
}
const argv = (command: string) => commandsRun(command)[0]?.words.slice(1) ?? [];

describe("complete body and discussion reads", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;
	let issue: number;
	let pull: number;
	let comment: number;
	let base: string;
	let url: string;
	beforeAll(async () => {
		server = await loadServer();
		({ repo, number: pull } = await createPull(server));
		cwd = await makeWorkDir(server); // Continuations must work without git origin.
		issue = await createIssue(server, repo, "Body parts");
		comment = await addComment(server, repo, issue, "initial");
		base = `/repos/${repo.owner}/${repo.name}`;
		url = `${server.url}/${repo.owner}/${repo.name}`;
		await webProfile(server, cwd, { web: false });
	}, 60_000);
	const target = (noun: string) =>
		noun === "comment"
			? `${url}/issues/${issue}#issuecomment-${comment}`
			: `${url}/${noun === "pr" ? "pulls" : "issues"}/${noun === "pr" ? pull : issue}`;
	const path = (noun: string) =>
		`${base}/${noun === "comment" ? `issues/comments/${comment}` : noun === "pr" ? `pulls/${pull}` : `issues/${issue}`}`;
	async function edit(noun: string, body: string) {
		const response = await fetch(`${server.url}/api/v1${path(noun)}`, {
			method: "PATCH",
			headers: {
				authorization: `token ${server.writeToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ body }),
		});
		expect(response.ok).toBe(true);
	}
	async function read(command: string): Promise<Part> {
		expect(gate(command).action).toBe("pass");
		const result = await runFgj(server, argv(command), cwd, {
			FGJ_PROFILE: "t",
		});
		expect(result.stdout.length).toBeLessThanOrEqual(28000);
		const part = await expectOk<Part>(result);
		expect(onlyGets(result)).toBe(true);
		return part;
	}
	async function complete(first: Part): Promise<string> {
		let part = first;
		let body = part.body;
		let count = 0;
		while (part.body_next) {
			const offset = Array.from(body).length;
			part = await read(part.body_next);
			expect(part.body_offset).toBe(offset);
			expect(part.body_revision).toBe(first.body_revision);
			expect(part.body.length).toBeGreaterThan(0);
			body += part.body;
			expect(++count).toBeLessThan(100);
		}
		expect(part.body_truncated).toBeUndefined();
		return body;
	}
	for (const noun of ["issue", "pr", "comment"]) {
		test(`${noun}: empty, boundaries, Unicode and escaped parts reconstruct exactly`, async () => {
			for (const body of [
				"",
				...[3999, 4000, 4001, 19999, 20000, 20001].map((n) => "x".repeat(n)),
				'😀中"\\\r\n\t'.repeat(9000),
			]) {
				if (noun === "comment" && body === "") continue; // Forgejo refuses empty comment edits.
				await edit(noun, body);
				const part = await read(
					`fgj read ${noun} get '${target(noun)}' --body-max ${body.length < 5000 ? 4000 : 20000}`,
				);
				expect(await complete(part)).toBe(body);
				expect(Boolean(part.discussion)).toBe(noun !== "comment");
			}
		}, 60_000);
		test(`${noun}: a changed body refuses mixed revisions and gives a working restart`, async () => {
			await edit(noun, "before".repeat(10000));
			const part = await read(`fgj read ${noun} get '${target(noun)}'`);
			const replacement = "after".repeat(13000);
			await edit(noun, replacement);
			const error = await expectError(
				await runFgj(server, argv(String(part.body_next)), cwd, {
					FGJ_PROFILE: "t",
				}),
				"conflict",
				5,
			);
			expect(error.message).toContain("Body changed");
			expect(error.hint).not.toContain("--body-after");
			expect(await complete(await read(error.hint))).toBe(replacement);
		}, 30_000);
		test(`${noun}: malformed cursors and incompatible selections fail locally`, async () => {
			for (const cursor of [
				"x",
				`${"a".repeat(64)}:0`,
				`${"a".repeat(64)}:-1`,
				`${"a".repeat(64)}:1.5`,
				`${"a".repeat(64)}:9007199254740992`,
			]) {
				const result = await runFgj(
					server,
					["read", noun, "get", target(noun), "--body-after", cursor],
					cwd,
				);
				await expectError(result, "usage", 2);
				expect(httpCalls(result)).toEqual([]);
			}
			const result = await runFgj(
				server,
				[
					"read",
					noun,
					"get",
					target(noun),
					"--fields",
					"author",
					"--body-after",
					`${"a".repeat(64)}:1`,
				],
				cwd,
			);
			await expectError(result, "usage", 2);
			expect(httpCalls(result)).toEqual([]);
		});
	}
	test("registered credentials are refused before splitting, for every body read path", async () => {
		const secret = "synthetic-token-1234567890";
		const body = `prefix ${secret} suffix`;
		for (const noun of ["issue", "pr", "comment"]) await edit(noun, body);
		for (const args of [
			...["issue", "pr", "comment"].map((noun) => [
				"read",
				noun,
				"get",
				target(noun),
			]),
			["read", "comment", "list", target("issue")],
			["read", "issue", "get", target("issue"), `${url}/issues/${pull}`],
		]) {
			const result = await runFgj(server, [...args, "--body-max", "5"], cwd, {
				FGJ_PROFILE: "t",
				FGJ_WRITE_TOKEN: secret,
			});
			const error = await expectError(result, "conflict", 5);
			expect(error.message).toContain("known credential");
			expect(result.stdout).toBe("");
			expect(result.stderr).not.toContain(secret);
		}
	});

	test("selected comment windows ignore credentials outside the window", async () => {
		const secret = "synthetic-token-1234567890";
		const thread = await createIssue(server, repo, "Safe selected window");
		await addComment(server, repo, thread, secret);
		const safe = await addComment(
			server,
			repo,
			thread,
			"Safe recent discussion",
		);
		for (const flags of [
			["--last", "1"],
			["--offset", "1"],
		]) {
			const result = await runFgj(
				server,
				["read", "comment", "list", `${url}/issues/${thread}`, ...flags],
				cwd,
				{ FGJ_PROFILE: "t", FGJ_WRITE_TOKEN: secret },
			);
			const page = await expectOk<{ items: Part[]; total: number; next: null }>(
				result,
			);
			expect(page.total).toBe(2);
			expect(page.next).toBeNull();
			expect(page.items.map((item) => item.id)).toEqual([safe]);
		}
	});

	test("PR discussion bodies continue from both pages and comment URLs", async () => {
		const body = "PR decision.\n" + "x".repeat(60000);
		const id = await addComment(server, repo, pull, body);
		const page = await expectOk<{ items: Part[] }>(
			await runFgj(
				server,
				["read", "comment", "list", `${url}/pulls/${pull}`],
				cwd,
				{ FGJ_PROFILE: "t" },
			),
		);
		const part = page.items.find((item) => item.id === id) as Part;
		expect(await complete(part)).toBe(body);
		const direct = await read(
			`fgj read comment get '${url}/pulls/${pull}#issuecomment-${id}'`,
		);
		expect(await complete(direct)).toBe(body);
	});

	test("out-of-range cursors fail and multi-item/head continuations fail locally", async () => {
		await edit("issue", "abcde");
		const part = await read(
			`fgj read issue get ${target("issue")} --body-max 1`,
		);
		const outside = argv(String(part.body_next));
		outside[outside.length - 1] = `${part.body_revision}:5`;
		const error = await expectError(
			await runFgj(server, outside, cwd, { FGJ_PROFILE: "t" }),
			"usage",
			2,
		);
		expect(error.hint).not.toContain("--body-after");
		for (const args of [
			[
				"read",
				"issue",
				"get",
				target("issue"),
				"999",
				"--body-after",
				`${part.body_revision}:1`,
			],
			[
				"read",
				"pr",
				"get",
				"--head",
				"main",
				"--body-after",
				`${part.body_revision}:1`,
			],
		]) {
			const result = await runFgj(server, args, cwd);
			await expectError(result, "usage", 2);
			expect(httpCalls(result)).toEqual([]);
		}
	});

	test("discussion pages and cut bodies are independent, with order and subsets preserved", async () => {
		const thread = await createIssue(server, repo, "Discussion");
		const originals = new Map<number, string>();
		for (let i = 0; i < 25; i++) {
			const body =
				i === 3 || i === 23
					? `${i}:` + "decision😀\\\n".repeat(5000)
					: `comment ${i}`;
			originals.set(await addComment(server, repo, thread, body), body);
		}
		const description = await read(
			`fgj read issue get ${url}/issues/${thread}`,
		);
		let command = description.discussion;
		const seen: number[] = [];
		let pages = 0;
		while (command) {
			const result = await runFgj(server, argv(command), cwd, {
				FGJ_PROFILE: "t",
			});
			expect(result.stdout.length).toBeLessThanOrEqual(28000);
			const page = await expectOk<{
				items: Part[];
				next: string | null;
				total: number;
			}>(result);
			expect(page.total).toBe(25);
			for (const part of page.items) {
				expect(await complete(part)).toBe(
					originals.get(part.id as number) as string,
				);
				seen.push(part.id as number);
			}
			command = page.next ?? undefined;
			pages++;
		}
		expect(pages).toBeGreaterThan(1);
		expect(seen).toEqual([...originals.keys()]);
		const subset = await expectOk<{ items: Part[]; total: number; next: null }>(
			await runFgj(
				server,
				[
					"read",
					"comment",
					"list",
					`${url}/issues/${thread}`,
					"--last",
					"1",
					"--contains",
					"decision",
					"--fields",
					"id,body",
				],
				cwd,
				{ FGJ_PROFILE: "t" },
			),
		);
		expect(subset.total).toBe(2);
		expect(subset.next).toBeNull();
		expect(await complete(subset.items[0] as Part)).toBe(
			originals.get(seen[23] as number) as string,
		);
	}, 60_000);
	test("multiple items retain each continuation and explicit identity; metadata stays cheap", async () => {
		const body = "long".repeat(15001);
		const number = await addPull(server, repo, "Long PR", body);
		const second = await addPull(server, repo, "Another PR", body);
		for (const noun of ["issue", "pr"]) {
			const result = await runFgj(
				server,
				[
					"read",
					noun,
					"get",
					`${url}/pulls/${number}`,
					`${url}/pulls/${second}`,
					"--as",
					"t",
					"--repo",
					`${repo.owner}/${repo.name}`,
				],
				cwd,
			);
			const out = await expectOk<{ items: Part[] }>(result);
			expect(out.items).toHaveLength(2);
			for (const part of out.items) {
				expect(part.body_next).toContain("--as t");
				expect(part.body_next).toContain(`--repo ${repo.owner}/${repo.name}`);
				expect(await complete(part)).toBe(body);
			}
			const metadata = await runFgj(
				server,
				["read", noun, "get", `${url}/pulls/${number}`, "--fields", "number"],
				cwd,
				{ FGJ_PROFILE: "t" },
			);
			expect(await expectOk<Record<string, unknown>>(metadata)).toEqual({
				number,
				...(noun === "issue" ? { pr: true } : {}),
				as: "t",
			});
			expect(httpCalls(metadata)).toHaveLength(1);
		}
	}, 30_000);
});

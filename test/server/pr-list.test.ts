import { beforeAll, describe, expect, test } from "bun:test";
import {
	adminApi,
	createLabel,
	createUser,
	expectError,
	expectOk,
	type FixtureRepo,
	httpCalls,
	loadServer,
	makeWorkDir,
	onlyGets,
	pushBranch,
	runFgj,
	type TestServer,
	waitMergeable,
} from "../support/forgejo.ts";

interface Item {
	number: number;
	state?: string;
	[key: string]: unknown;
}

interface Page {
	items: Item[];
	total: number;
	next: string | null;
	as: string;
}

describe("fgj read pr list and pr get --head", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;
	/** PR numbers by name: open, labelled, into dev, merged, closed. */
	type Key = "plain" | "bug" | "dev" | "merged" | "closed";
	const prs = {} as Record<Key, number>;
	const shas = {} as Record<Key, string>;

	beforeAll(async () => {
		server = await loadServer();
		const name = `t-${crypto.randomUUID().slice(0, 8)}`;
		await adminApi(server, "/user/repos", { name, auto_init: true });
		repo = { owner: server.username, name };
		cwd = await makeWorkDir(server, repo);
		const base = `/repos/${repo.owner}/${repo.name}`;
		await adminApi(server, `${base}/branches`, { new_branch_name: "dev" });
		const bug = await createLabel(server, repo, "type/bug");
		const open = async (key: Key, into = "main", labels: number[] = []) => {
			const head = `feat/${key}`;
			shas[key] = await pushBranch(server, repo, head);
			prs[key] = (
				await adminApi<{ number: number }>(server, `${base}/pulls`, {
					head,
					base: into,
					title: `PR ${key}`,
					labels,
				})
			).number;
		};
		await open("plain");
		await open("bug", "main", [bug]);
		await open("dev", "dev");
		await open("merged");
		await open("closed");
		await waitMergeable(server, repo, prs.merged as number);
		await adminApi(server, `${base}/pulls/${prs.merged}/merge`, {
			Do: "merge",
		});
		await fetch(`${server.url}/api/v1${base}/pulls/${prs.closed}`, {
			method: "PATCH",
			headers: {
				authorization: `Basic ${btoa(`${server.username}:${server.password}`)}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ state: "closed" }),
		});
	}, 60_000);

	const list = (...argv: string[]) =>
		runFgj(server, ["read", "pr", "list", ...argv], cwd);

	const numbers = (page: Page) => page.items.map((i) => i.number).sort();

	test("the default lists open PRs with names, not objects, and GET only", async () => {
		const result = await list();
		const out = await expectOk<Page>(result);
		expect(numbers(out)).toEqual(
			[prs.plain, prs.bug, prs.dev].map(Number).sort(),
		);
		expect(out.total).toBe(3);
		expect(out.next).toBeNull();
		const bug = out.items.find((i) => i.number === prs.bug);
		expect(bug).toEqual({
			number: prs.bug,
			title: "PR bug",
			state: "open",
			draft: false,
			head: "feat/bug",
			base: "main",
			url: `${server.url}/${repo.owner}/${repo.name}/pulls/${prs.bug}`,
			head_sha: shas.bug,
			labels: ["type/bug"],
		});
		expect(onlyGets(result)).toBe(true);
	});

	test("--state closed lists closed and merged PRs, and each item says which", async () => {
		const out = await expectOk<Page>(await list("--state", "closed"));
		const states = Object.fromEntries(
			out.items.map((i) => [i.number, i.state]),
		);
		expect(states).toEqual({
			[prs.merged as number]: "merged",
			[prs.closed as number]: "closed",
		});
		await expectError(await list("--state", "merged"), "usage", 2);
		expect((await expectOk<Page>(await list("--state", "all"))).total).toBe(5);
	});

	test("--base, --author, and --label by name filter on the server", async () => {
		expect(numbers(await expectOk<Page>(await list("--base", "dev")))).toEqual([
			prs.dev,
		]);
		const labelled = await list("--label", "TYPE/BUG");
		expect(numbers(await expectOk<Page>(labelled))).toEqual([prs.bug]);
		expect(
			httpCalls(labelled).some((c) => /\/pulls\?.*labels=\d+/.test(c)),
		).toBe(true);
		expect(
			(await expectOk<Page>(await list("--author", server.username))).total,
		).toBe(3);
		const other = await createUser(server);
		expect(
			(await expectOk<Page>(await list("--author", other.username))).total,
		).toBe(0);
		await expectError(await list("--label", "type/bug,x"), "usage", 2);
		await expectError(await list("--label", "nope"), "usage", 2);
		await expectError(await list("--author", "no-such-user"), "not_found", 4);
	});

	test("--limit pages with an exact next command", async () => {
		const first = await expectOk<Page>(await list("--limit", "2"));
		expect(first.items).toHaveLength(2);
		expect(first.next).toBe("fgj read pr list --limit 2 --offset 2");
		const second = await expectOk<Page>(
			await list("--limit", "2", "--offset", "2"),
		);
		expect(second.items).toHaveLength(1);
		expect(second.next).toBeNull();
	});

	test("pr get --head reads the open PR of a branch, in the shape of pr get N", async () => {
		const get = (...argv: string[]) =>
			runFgj(server, ["read", "pr", "get", ...argv], cwd);
		// mergeable changes while Forgejo checks a new PR; compare after the check.
		await waitMergeable(server, repo, prs.bug as number);
		const byHead = await expectOk<Item>(await get("--head", "feat/bug"));
		const byNumber = await expectOk<Item>(await get(String(prs.bug)));
		expect(byHead).toEqual(byNumber);
		const err = await expectError(
			await get("--head", "feat/merged"),
			"not_found",
			4,
		);
		expect(err.message).toContain("No open pull request for the branch");
		expect(err.hint).toBe("fgj read pr list --state all");
		// One branch can have an open PR into two bases: fgj names both.
		await adminApi(server, `/repos/${repo.owner}/${repo.name}/pulls`, {
			head: "feat/dev",
			base: "main",
			title: "PR dev into main",
		});
		const two = await expectError(
			await get("--head", "feat/dev"),
			"conflict",
			5,
		);
		expect(two.message).toContain(`#${prs.dev}`);
		expect(two.hint).toBe("fgj read pr list");
		await expectError(await get("1", "--head", "feat/bug"), "usage", 2);
		await expectError(await get("--head", "o:feat/bug"), "usage", 2);
	});

	test("pr get --head ignores a PR from a fork that uses the same branch name", async () => {
		const other = await createUser(server);
		const base = `/repos/${repo.owner}/${repo.name}`;
		const fork = await adminApi<{ full_name: string }>(
			server,
			`${base}/forks`,
			{},
			other,
		);
		const forkPath = `/repos/${fork.full_name}`;
		// A fork copies the branches, so feat/bug is already in it.
		await adminApi(
			server,
			`${forkPath}/branches`,
			{ new_branch_name: "feat/fork-only" },
			other,
		);
		for (const branch of ["feat/fork-only", "feat/bug"]) {
			await adminApi(
				server,
				`${forkPath}/contents/${crypto.randomUUID().slice(0, 8)}.txt`,
				{ content: btoa(branch), branch, message: branch },
				other,
			);
			await adminApi(
				server,
				`${base}/pulls`,
				{
					head: `${other.username}:${branch}`,
					base: "main",
					title: `fork ${branch}`,
				},
				other,
			);
		}
		const get = (...argv: string[]) =>
			runFgj(server, ["read", "pr", "get", ...argv], cwd);
		// Only the fork has this branch: not this repository's PR.
		await expectError(await get("--head", "feat/fork-only"), "not_found", 4);
		// Both have feat/bug: fgj returns this repository's PR, with no conflict.
		expect((await expectOk<Item>(await get("--head", "feat/bug"))).number).toBe(
			prs.bug,
		);
	}, 60_000);
});

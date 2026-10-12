import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	addDependency,
	adminApi,
	createIssue,
	createRepo,
	expectError,
	type FixtureRepo,
	httpCalls,
	loadServer,
	makeWorkDir,
	onlyGets,
	runFgj,
	type TestServer,
} from "../support/forgejo.ts";

interface One {
	changed: boolean;
	number: number;
	dry_run?: true;
	apply?: string;
	as: string;
}

interface Item {
	number: number;
	changed?: boolean;
	error?: { code: string; message: string; hint: string };
}

interface Many {
	items: Item[];
	dry_run?: true;
	apply?: string;
	as: string;
}

describe("fgj write issue close and reopen", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		cwd = await makeWorkDir(server, repo);
	}, 60_000);

	const run = (action: string, ...rest: string[]) =>
		runFgj(server, ["write", "issue", action, ...rest], cwd);

	const stateOf = async (n: number) =>
		(
			await adminApi<{ state: string }>(
				server,
				`/repos/${repo.owner}/${repo.name}/issues/${n}`,
			)
		).state;

	const setState = (n: number, state: string) =>
		fetch(`${server.url}/api/v1/repos/${repo.owner}/${repo.name}/issues/${n}`, {
			method: "PATCH",
			headers: {
				authorization: `Basic ${btoa(`${server.username}:${server.password}`)}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ state }),
		});

	/** Parses stdout even when the exit code shows a failure. */
	const parse = <T>(r: { stdout: string }) => JSON.parse(r.stdout) as T;

	test("closes one issue, and a repeat returns changed:false with no change sent", async () => {
		const n = await createIssue(server, repo, "Close me");
		const first = await run("close", String(n));
		expect(first.code).toBe(0);
		expect(parse<One>(first)).toEqual({ changed: true, number: n, as: "env" });
		expect(await stateOf(n)).toBe("closed");
		const again = await run("close", String(n));
		expect(parse<One>(again)).toEqual({ changed: false, number: n, as: "env" });
		expect(onlyGets(again)).toBe(true);
	});

	test("reopens one issue, and a repeat returns changed:false", async () => {
		const n = await createIssue(server, repo, "Reopen me");
		await setState(n, "closed");
		expect(parse<One>(await run("reopen", String(n)))).toMatchObject({
			changed: true,
		});
		expect(await stateOf(n)).toBe("open");
		expect(parse<One>(await run("reopen", String(n)))).toMatchObject({
			changed: false,
		});
	});

	test("many issues return one item each, in the order given", async () => {
		const a = await createIssue(server, repo, "A");
		const b = await createIssue(server, repo, "B");
		const c = await createIssue(server, repo, "C");
		await setState(b, "closed");
		const r = await run("close", String(a), String(b), String(c));
		expect(r.code).toBe(0);
		expect(parse<Many>(r).items).toEqual([
			{ number: a, changed: true },
			{ number: b, changed: false },
			{ number: c, changed: true },
		]);
	});

	test("an issue with open dependencies stays open, the others close, and the exit code shows the conflict", async () => {
		const a = await createIssue(server, repo, "Free A");
		const blocked = await createIssue(server, repo, "Blocked");
		const blocker = await createIssue(server, repo, "Blocker");
		const c = await createIssue(server, repo, "Free C");
		await addDependency(server, repo, blocked, { number: blocker });
		const r = await run("close", String(a), String(blocked), String(c));
		expect(r.code).toBe(5);
		// A partial failure is a result on stdout, not an error on stderr.
		expect(r.stderr).toBe("");
		const items = parse<Many>(r).items;
		expect(items[0]).toEqual({ number: a, changed: true });
		expect(items[2]).toEqual({ number: c, changed: true });
		expect(items[1]?.number).toBe(blocked);
		expect(items[1]?.error?.code).toBe("conflict");
		expect(items[1]?.error?.message).toContain("open dependencies");
		expect(items[1]?.error?.hint).toBe(
			`fgj read issue get ${blocked} --fields number,depends_on`,
		);
		expect(await stateOf(a)).toBe("closed");
		expect(await stateOf(blocked)).toBe("open");
		expect(await stateOf(c)).toBe("closed");
		const audit = (
			await Bun.file(join(cwd, ".local", "state", "fgj", "audit.jsonl")).text()
		)
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.at(-1);
		expect(audit.result.items).toEqual([
			{ number: a, changed: true },
			{ number: blocked, error: "conflict" },
			{ number: c, changed: true },
		]);
	});

	test("one blocked issue fails with conflict on stderr", async () => {
		const blocked = await createIssue(server, repo, "Alone and blocked");
		const blocker = await createIssue(server, repo, "Its blocker");
		await addDependency(server, repo, blocked, { number: blocker });
		const err = await expectError(
			await run("close", String(blocked)),
			"conflict",
			5,
		);
		expect(err.hint).toBe(
			`fgj read issue get ${blocked} --fields number,depends_on`,
		);
	});

	test("a missing issue is its own not_found item, and a single one fails with not_found", async () => {
		const a = await createIssue(server, repo, "Present");
		const r = await run("close", String(a), "999999");
		expect(r.code).toBe(4);
		expect(parse<Many>(r).items[1]).toMatchObject({
			number: 999999,
			error: { code: "not_found" },
		});
		await expectError(await run("close", "999999"), "not_found", 4);
	});

	test("--dry-run predicts each item, changes nothing, and gives the apply command", async () => {
		const a = await createIssue(server, repo, "Dry A");
		const b = await createIssue(server, repo, "Dry B");
		await setState(b, "closed");
		const r = await run("close", String(a), String(b), "--dry-run");
		expect(r.code).toBe(0);
		expect(parse<Many>(r)).toMatchObject({
			dry_run: true,
			items: [
				{ number: a, changed: true },
				{ number: b, changed: false },
			],
			apply: `fgj write issue close ${a} ${b}`,
		});
		expect(onlyGets(r)).toBe(true);
		expect(await stateOf(a)).toBe("open");
	});

	test("more than 50 issues fail with usage before any request", async () => {
		const r = await run(
			"close",
			...Array.from({ length: 51 }, (_, i) => String(i + 1)),
		);
		await expectError(r, "usage", 2);
		expect(httpCalls(r)).toEqual([]);
	});

	test("a number next to an issue URL fails with usage, so a write never moves to the URL's repository", async () => {
		const other = await createRepo(server);
		const url = `${server.url}/${other.owner}/${other.name}/issues/1`;
		const r = await run("close", "1", url);
		await expectError(r, "usage", 2);
		expect(httpCalls(r)).toEqual([]);
	});

	test("the conflict hint keeps --repo, so it reads the same repository", async () => {
		const blocked = await createIssue(server, repo, "Blocked elsewhere");
		const blocker = await createIssue(server, repo, "Blocker elsewhere");
		await addDependency(server, repo, blocked, { number: blocker });
		const r = await runFgj(
			server,
			[
				"write",
				"issue",
				"close",
				String(blocked),
				"--repo",
				`${repo.owner}/${repo.name}`,
			],
			await makeWorkDir(server),
		);
		const err = await expectError(r, "conflict", 5);
		expect(err.hint).toBe(
			`fgj read issue get ${blocked} --fields number,depends_on --repo ${repo.owner}/${repo.name}`,
		);
	});

	test("--dry-run predicts the open-dependency conflict, as the real run fails", async () => {
		const free = await createIssue(server, repo, "Dry free");
		const blocked = await createIssue(server, repo, "Dry blocked");
		const blocker = await createIssue(server, repo, "Dry blocker");
		await addDependency(server, repo, blocked, { number: blocker });
		const r = await run("close", String(free), String(blocked), "--dry-run");
		expect(r.code).toBe(5);
		const out = parse<Many>(r);
		expect(out.items[0]).toEqual({ number: free, changed: true });
		expect(out.items[1]?.error?.code).toBe("conflict");
		expect(onlyGets(r)).toBe(true);
		const one = await expectError(
			await run("close", String(blocked), "--dry-run"),
			"conflict",
			5,
		);
		expect(one.message).toContain("open dependencies");
	});

	test("--dry-run counts a dependency that closes earlier in the same call, as the real run does", async () => {
		const first = await createIssue(server, repo, "Closes first");
		const second = await createIssue(server, repo, "Waits on first");
		await addDependency(server, repo, second, { number: first });
		const plan = await run("close", String(first), String(second), "--dry-run");
		expect(plan.code).toBe(0);
		expect(parse<Many>(plan).items).toEqual([
			{ number: first, changed: true },
			{ number: second, changed: true },
		]);
		const real = await run("close", String(first), String(second));
		expect(real.code).toBe(0);
	});
});

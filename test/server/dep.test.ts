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
	on: number;
	dry_run?: true;
	apply?: string;
	as: string;
}

interface Many {
	number: number;
	items: {
		on: number;
		changed?: boolean;
		error?: { code: string; hint: string };
	}[];
	dry_run?: true;
	apply?: string;
	as: string;
}

describe("fgj write dep add and remove", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		cwd = await makeWorkDir(server, repo);
	}, 60_000);

	const dep = (action: string, ...rest: string[]) =>
		runFgj(server, ["write", "dep", action, ...rest], cwd);

	const parse = <T>(r: { stdout: string }) => JSON.parse(r.stdout) as T;

	const dependsOn = async (n: number) =>
		(
			await adminApi<{ number: number }[]>(
				server,
				`/repos/${repo.owner}/${repo.name}/issues/${n}/dependencies`,
			)
		)
			.map((i) => i.number)
			.sort((x, y) => x - y);

	test("adds one dependency, and a repeat returns changed:false with only reads", async () => {
		const a = await createIssue(server, repo, "Waits");
		const b = await createIssue(server, repo, "Goes first");
		const first = await dep("add", String(a), String(b));
		expect(first.code).toBe(0);
		expect(parse<One>(first)).toEqual({
			changed: true,
			number: a,
			on: b,
			as: "env",
		});
		expect(await dependsOn(a)).toEqual([b]);
		const again = await dep("add", String(a), `#${b}`);
		expect(parse<One>(again)).toMatchObject({ changed: false, on: b });
		expect(onlyGets(again)).toBe(true);
	});

	test("removes one dependency, and a repeat returns changed:false with only reads", async () => {
		const a = await createIssue(server, repo, "Was waiting");
		const b = await createIssue(server, repo, "Was first");
		await addDependency(server, repo, a, { number: b });
		expect(parse<One>(await dep("remove", String(a), String(b)))).toEqual({
			changed: true,
			number: a,
			on: b,
			as: "env",
		});
		expect(await dependsOn(a)).toEqual([]);
		const again = await dep("remove", String(a), String(b));
		expect(parse<One>(again)).toMatchObject({ changed: false });
		expect(onlyGets(again)).toBe(true);
	});

	test("many targets return one entry each, and a missing one fails alone with not_found", async () => {
		const a = await createIssue(server, repo, "Waits on many");
		const b = await createIssue(server, repo, "First B");
		const c = await createIssue(server, repo, "First C");
		await addDependency(server, repo, a, { number: b });
		const r = await dep("add", String(a), String(b), String(c), "999999");
		expect(r.code).toBe(4);
		const out = parse<Many>(r);
		expect(out.number).toBe(a);
		expect(out.items[0]).toEqual({ on: b, changed: false });
		expect(out.items[1]).toEqual({ on: c, changed: true });
		expect(out.items[2]).toMatchObject({
			on: 999999,
			error: { code: "not_found" },
		});
		expect(await dependsOn(a)).toEqual([b, c]);
		const audit = (
			await Bun.file(join(cwd, ".local", "state", "fgj", "audit.jsonl")).text()
		)
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.at(-1);
		expect(audit.result.items).toEqual([
			{ on: b, changed: false },
			{ on: c, changed: true },
			{ on: 999999, error: "not_found" },
		]);
	});

	test("a self-dependency fails with usage before any request", async () => {
		const a = await createIssue(server, repo, "Self");
		for (const argv of [
			[String(a), String(a)],
			[String(a), "2", `#${a}`],
		]) {
			const r = await dep("add", ...argv);
			await expectError(r, "usage", 2);
			expect(httpCalls(r)).toEqual([]);
		}
	});

	test("a circular dependency fails with conflict", async () => {
		const a = await createIssue(server, repo, "Circle A");
		const b = await createIssue(server, repo, "Circle B");
		await addDependency(server, repo, b, { number: a });
		const err = await expectError(
			await dep("add", String(a), String(b)),
			"conflict",
			5,
		);
		expect(err.message).toContain("circular");
		expect(await dependsOn(a)).toEqual([]);
	});

	test("a missing issue that would depend fails with not_found", async () => {
		const b = await createIssue(server, repo, "Target");
		await expectError(await dep("add", "999999", String(b)), "not_found", 4);
	});

	test("--dry-run predicts each target, changes nothing, and gives the apply command", async () => {
		const a = await createIssue(server, repo, "Dry waits");
		const b = await createIssue(server, repo, "Dry B");
		const c = await createIssue(server, repo, "Dry C");
		await addDependency(server, repo, a, { number: b });
		const r = await dep("add", String(a), String(b), String(c), "--dry-run");
		expect(parse<Many>(r)).toMatchObject({
			dry_run: true,
			number: a,
			items: [
				{ on: b, changed: false },
				{ on: c, changed: true },
			],
			apply: `fgj write dep add ${a} ${b} ${c}`,
		});
		expect(onlyGets(r)).toBe(true);
		expect(await dependsOn(a)).toEqual([b]);
	});

	test("fewer than two issues fail with usage before any request", async () => {
		const r = await dep("add", "5");
		await expectError(r, "usage", 2);
		expect(httpCalls(r)).toEqual([]);
	});

	test("a number next to an issue URL fails with usage before any request", async () => {
		const other = await createRepo(server);
		const r = await dep(
			"add",
			"1",
			`${server.url}/${other.owner}/${other.name}/issues/2`,
		);
		await expectError(r, "usage", 2);
		expect(httpCalls(r)).toEqual([]);
	});

	test("the circular-dependency hint keeps --repo", async () => {
		const a = await createIssue(server, repo, "Hint A");
		const b = await createIssue(server, repo, "Hint B");
		await addDependency(server, repo, b, { number: a });
		const err = await expectError(
			await runFgj(
				server,
				[
					"write",
					"dep",
					"add",
					String(a),
					String(b),
					"--repo",
					`${repo.owner}/${repo.name}`,
				],
				await makeWorkDir(server),
			),
			"conflict",
			5,
		);
		expect(err.hint).toBe(
			`fgj read issue get ${a} ${b} --fields number,depends_on,blocks --repo ${repo.owner}/${repo.name}`,
		);
	});

	test("--dry-run predicts a missing target and a circle, as the real run fails", async () => {
		const a = await createIssue(server, repo, "Dry circle A");
		const b = await createIssue(server, repo, "Dry circle B");
		await addDependency(server, repo, b, { number: a });
		const r = await dep("add", String(a), String(b), "999999", "--dry-run");
		expect(r.code).toBe(5);
		const out = parse<Many>(r);
		expect(out.items[0]?.error?.code).toBe("conflict");
		expect(out.items[1]?.error?.code).toBe("not_found");
		expect(onlyGets(r)).toBe(true);
	});
});

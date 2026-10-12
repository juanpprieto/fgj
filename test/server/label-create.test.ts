import { beforeAll, describe, expect, test } from "bun:test";
import {
	adminApi,
	createIssue,
	createLabel,
	createRepo,
	expectError,
	expectOk,
	loadServer,
	makeWorkDir,
	onlyGets,
	runFgj,
	type TestServer,
} from "../support/forgejo.ts";

interface StoredLabel {
	id: number;
	name: string;
	color: string;
	description: string;
	exclusive: boolean;
}

describe("fgj write label create", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await loadServer();
	});

	/** A new repository, a work dir with it as origin, and a label reader. */
	const setup = async () => {
		const repo = await createRepo(server);
		const cwd = await makeWorkDir(server, repo);
		const stored = () =>
			adminApi<StoredLabel[]>(
				server,
				`/repos/${repo.owner}/${repo.name}/labels?limit=50`,
			);
		const create = (...argv: string[]) =>
			runFgj(server, ["write", "label", "create", ...argv], cwd);
		return { repo, cwd, stored, create };
	};

	test("creates a label with its color, description, and exclusivity, and label list shows it", async () => {
		const { cwd, stored, create } = await setup();
		const out = await expectOk<Record<string, unknown>>(
			await create(
				"--name",
				"priority/high",
				"--color",
				"B60205",
				"--description",
				"Do it first",
				"--exclusive",
			),
		);
		expect(out).toEqual({ changed: true, name: "priority/high", as: "env" });
		expect(await stored()).toMatchObject([
			{
				name: "priority/high",
				color: "b60205",
				description: "Do it first",
				exclusive: true,
			},
		]);
		const list = await expectOk<{ items: unknown[] }>(
			await runFgj(server, ["read", "label", "list"], cwd),
		);
		expect(list.items).toEqual([{ name: "priority/high", exclusive: true }]);
	});

	test("--dry-run writes nothing and gives the apply command", async () => {
		const { stored, create } = await setup();
		const result = await create(
			"--name",
			"type/epic",
			"--color",
			"5319e7",
			"--dry-run",
		);
		expect(await expectOk<Record<string, unknown>>(result)).toEqual({
			dry_run: true,
			changed: true,
			name: "type/epic",
			apply: "fgj write label create --name type/epic --color 5319e7",
			as: "env",
		});
		expect(onlyGets(result)).toBe(true);
		expect(await stored()).toEqual([]);
	});

	test("a repeat, also in another letter case, returns changed:false with the stored name and sends no write", async () => {
		const { stored, create } = await setup();
		await expectOk(await create("--name", "type/epic", "--color", "5319e7"));
		for (const name of ["type/epic", "Type/Epic"]) {
			const again = await create("--name", name, "--color", "5319E7");
			expect(await expectOk<Record<string, unknown>>(again)).toEqual({
				changed: false,
				name: "type/epic",
				as: "env",
			});
			expect(onlyGets(again)).toBe(true);
		}
		const dry = await create(
			"--name",
			"type/epic",
			"--color",
			"5319e7",
			"--dry-run",
		);
		expect(await expectOk<Record<string, unknown>>(dry)).toMatchObject({
			dry_run: true,
			changed: false,
		});
		expect(await stored()).toHaveLength(1);
	});

	test("a name that exists with another color, description, or exclusivity is a conflict, and nothing changes", async () => {
		const { stored, create } = await setup();
		await expectOk(
			await create(
				"--name",
				"priority/high",
				"--color",
				"b60205",
				"--description",
				"First",
			),
		);
		const before = await stored();
		for (const argv of [
			["--color", "000000", "--description", "First"],
			["--color", "b60205", "--description", "Other"],
			["--color", "b60205"],
			["--color", "b60205", "--description", "First", "--exclusive"],
		]) {
			const err = await expectError(
				await create("--name", "priority/high", ...argv),
				"conflict",
				5,
			);
			expect(err.message).toContain("priority/high");
		}
		// The dry run reports the same conflict.
		await expectError(
			await create("--name", "priority/high", "--color", "000000", "--dry-run"),
			"conflict",
			5,
		);
		expect(await stored()).toEqual(before);
	});

	test("two labels with the name, or an archived one, is a conflict, not a pick", async () => {
		const { repo, create } = await setup();
		await createLabel(server, repo, "dup");
		await createLabel(server, repo, "DUP");
		await createLabel(server, repo, "old", { archived: true });
		const two = await expectError(
			await create("--name", "dup", "--color", "00aabb"),
			"conflict",
			5,
		);
		expect(two.message).toContain("2 labels");
		const archived = await expectError(
			await create("--name", "old", "--color", "00aabb"),
			"conflict",
			5,
		);
		expect(archived.message).toContain("archived");
	});

	test("a stored name with spaces around it is a conflict, not a false success or a near-duplicate", async () => {
		const { repo, cwd, stored, create } = await setup();
		await createLabel(server, repo, " foo ");
		const again = await create("--name", "foo", "--color", "00aabb");
		const err = await expectError(again, "conflict", 5);
		expect(err.message).toContain('" foo "');
		expect(onlyGets(again)).toBe(true);
		// The dry run reports the same conflict.
		await expectError(
			await create("--name", "foo", "--color", "00aabb", "--dry-run"),
			"conflict",
			5,
		);
		expect(await stored()).toHaveLength(1);
		// issue edit cannot assign it by the trimmed name either, so a success would mislead.
		const n = await createIssue(server, repo, "Spaced");
		await expectError(
			await runFgj(
				server,
				["write", "issue", "edit", String(n), "--add-label", "foo"],
				cwd,
			),
			"usage",
			2,
		);
	});

	test("an exact name wins over a spaced one, as in issue edit", async () => {
		const { repo, create } = await setup();
		await createLabel(server, repo, "foo");
		await createLabel(server, repo, " foo");
		const again = await create("--name", "foo", "--color", "00aabb");
		expect(await expectOk<Record<string, unknown>>(again)).toMatchObject({
			changed: false,
			name: "foo",
		});
	});

	test("a label past the first page of the list is found, so a repeat makes no duplicate", async () => {
		const { repo, create } = await setup();
		// Two full server pages and one more: the last label is on page 3.
		const count = server.apiPage * 2 + 1;
		const name = (i: number) => `bulk/${String(i).padStart(2, "0")}`;
		for (let i = 0; i < count; i++) await createLabel(server, repo, name(i));
		const last = await create("--name", name(count - 1), "--color", "00aabb");
		expect(await expectOk<Record<string, unknown>>(last)).toMatchObject({
			changed: false,
			name: name(count - 1),
		});
		expect(onlyGets(last)).toBe(true);
		const pageOf = (n: number) =>
			adminApi<StoredLabel[]>(
				server,
				`/repos/${repo.owner}/${repo.name}/labels?page=${n}`,
			);
		const pages = await Promise.all([1, 2, 3, 4].map(pageOf));
		expect(pages[2]?.map((l) => l.name)).toEqual([name(count - 1)]);
		const names = pages.flat().map((l) => l.name);
		expect(names).toHaveLength(count);
		expect(new Set(names).size).toBe(count);
	});

	test("labels it creates work with issue edit, and an exclusive scope swaps", async () => {
		const { repo, cwd, create } = await setup();
		for (const [name, color] of [
			["priority/high", "b60205"],
			["priority/normal", "0e8a16"],
		] as const) {
			await expectOk(
				await create("--name", name, "--color", color, "--exclusive"),
			);
		}
		await expectOk(await create("--name", "type/epic", "--color", "5319e7"));
		const n = await createIssue(server, repo, "Plan");
		const edit = (label: string) =>
			runFgj(
				server,
				["write", "issue", "edit", String(n), "--add-label", label],
				cwd,
			);
		await expectOk(await edit("type/epic,priority/high"));
		await expectOk(await edit("priority/normal"));
		const issue = await expectOk<{ labels: string[] }>(
			await runFgj(
				server,
				["read", "issue", "get", String(n), "--fields", "labels"],
				cwd,
			),
		);
		expect([...issue.labels].sort()).toEqual(["priority/normal", "type/epic"]);
	}, 30_000);

	test("a write token without write:issue fails with auth and creates nothing", async () => {
		const { cwd, stored } = await setup();
		const result = await runFgj(
			server,
			["write", "label", "create", "--name", "x", "--color", "000000"],
			cwd,
			{ FGJ_WRITE_TOKEN: server.readToken },
		);
		await expectError(result, "auth", 3);
		expect(await stored()).toEqual([]);
	});
});

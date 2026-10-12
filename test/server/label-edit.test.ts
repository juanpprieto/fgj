import { beforeAll, describe, expect, test } from "bun:test";
import {
	adminApi,
	adminSend,
	createIssue,
	createLabel,
	createRepo,
	expectError,
	expectOk,
	httpCalls,
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

describe("fgj write label edit", () => {
	let server: TestServer;

	beforeAll(async () => {
		server = await loadServer();
	});

	/** A new repository, a work dir with it as origin, and readers for its labels and issues. */
	const setup = async () => {
		const repo = await createRepo(server);
		const cwd = await makeWorkDir(server, repo);
		const base = `/repos/${repo.owner}/${repo.name}`;
		const stored = () =>
			adminApi<StoredLabel[]>(server, `${base}/labels?limit=50`);
		const one = async (name: string) =>
			(await stored()).find((l) => l.name === name) as StoredLabel;
		const issueLabels = async (n: number) =>
			(
				await adminApi<{ labels: { name: string }[] }>(
					server,
					`${base}/issues/${n}`,
				)
			).labels
				.map((l) => l.name)
				.sort();
		const edit = (...argv: string[]) =>
			runFgj(server, ["write", "label", "edit", ...argv], cwd);
		return { repo, cwd, stored, one, issueLabels, edit };
	};

	test("changes only the given field, keeps the id, and the issue keeps the label", async () => {
		const { repo, one, issueLabels, edit } = await setup();
		const id = await createLabel(server, repo, "priority/p1", {
			exclusive: true,
			description: "Soon",
		});
		const n = await createIssue(server, repo, "Holds it", { labels: [id] });
		const result = await edit("priority/p1", "--color", "D93F0B");
		expect(await expectOk<Record<string, unknown>>(result)).toEqual({
			changed: true,
			name: "priority/p1",
			as: "env",
		});
		expect(httpCalls(result).filter((c) => !c.startsWith("GET"))).toEqual([
			`PATCH /repos/${repo.owner}/${repo.name}/labels/${id}`,
		]);
		expect(await one("priority/p1")).toMatchObject({
			id,
			color: "d93f0b",
			description: "Soon",
			exclusive: true,
		});
		expect(await issueLabels(n)).toEqual(["priority/p1"]);
	});

	test("--dry-run writes nothing; the apply command edits; a repeat sends no PATCH", async () => {
		const { repo, one, edit } = await setup();
		await createLabel(server, repo, "priority/p1");
		const before = await one("priority/p1");
		const dry = await edit(
			"priority/p1",
			"--color",
			"d93f0b",
			"--description",
			"Next approved work",
			"--dry-run",
		);
		const plan = await expectOk<Record<string, unknown>>(dry);
		expect(plan).toEqual({
			dry_run: true,
			changed: true,
			name: "priority/p1",
			apply:
				"fgj write label edit priority/p1 --color d93f0b --description 'Next approved work'",
			as: "env",
		});
		expect(onlyGets(dry)).toBe(true);
		expect(await one("priority/p1")).toEqual(before);
		const argv = ["priority/p1", "--color", "d93f0b"];
		argv.push("--description", "Next approved work");
		await expectOk(await edit(...argv));
		expect(await one("priority/p1")).toMatchObject({
			color: "d93f0b",
			description: "Next approved work",
			exclusive: false,
		});
		const again = await edit(...argv);
		expect(await expectOk<Record<string, unknown>>(again)).toEqual({
			changed: false,
			name: "priority/p1",
			as: "env",
		});
		expect(onlyGets(again)).toBe(true);
		const dryAgain = await edit(...argv, "--dry-run");
		expect(await expectOk<Record<string, unknown>>(dryAgain)).toMatchObject({
			dry_run: true,
			changed: false,
		});
	});

	test("--exclusive and --no-exclusive set each value; the issue keeps both labels of the scope", async () => {
		const { repo, one, issueLabels, edit } = await setup();
		const a = await createLabel(server, repo, "prio/a", {
			description: "Keep",
		});
		const b = await createLabel(server, repo, "prio/b");
		const n = await createIssue(server, repo, "Two", { labels: [a, b] });
		await expectOk(await edit("prio/a", "--exclusive"));
		expect(await one("prio/a")).toMatchObject({
			exclusive: true,
			description: "Keep",
			color: "00aabb",
		});
		// Forgejo moves no issue labels when a label turns exclusive.
		expect(await issueLabels(n)).toEqual(["prio/a", "prio/b"]);
		await expectOk(await edit("prio/a", "--no-exclusive"));
		expect(await one("prio/a")).toMatchObject({
			exclusive: false,
			description: "Keep",
		});
		const off = await edit("prio/a", "--no-exclusive");
		expect(await expectOk<Record<string, unknown>>(off)).toMatchObject({
			changed: false,
		});
		expect(onlyGets(off)).toBe(true);
	});

	test("Forgejo saves exclusive on a name with no scope, and an exclusive add removes only the other exclusive labels of the scope", async () => {
		const { repo, cwd, one, issueLabels } = await setup();
		const plain = await createLabel(server, repo, "plain");
		// fgj refuses this before a request; the server does not.
		await adminSend(
			server,
			"PATCH",
			`/repos/${repo.owner}/${repo.name}/labels/${plain}`,
			{
				exclusive: true,
			},
		);
		expect((await one("plain")).exclusive).toBe(true);
		const a = await createLabel(server, repo, "prio/a", { exclusive: true });
		const b = await createLabel(server, repo, "prio/b", { exclusive: true });
		const d = await createLabel(server, repo, "prio/d");
		await createLabel(server, repo, "prio/c", { exclusive: true });
		const n = await createIssue(server, repo, "Three", { labels: [a, b, d] });
		expect(await issueLabels(n)).toEqual(["prio/a", "prio/b", "prio/d"]);
		await expectOk(
			await runFgj(
				server,
				["write", "issue", "edit", String(n), "--add-label", "prio/c"],
				cwd,
			),
		);
		expect(await issueLabels(n)).toEqual(["prio/c", "prio/d"]);
	});

	test("a --no-exclusive dry run gives an apply command that edits", async () => {
		const { repo, one, edit } = await setup();
		await createLabel(server, repo, "prio/a", { exclusive: true });
		const dry = await edit("prio/a", "--no-exclusive", "--dry-run");
		const plan = await expectOk<{ apply: string }>(dry);
		expect(plan.apply).toBe("fgj write label edit prio/a --no-exclusive");
		expect(onlyGets(dry)).toBe(true);
		expect((await one("prio/a")).exclusive).toBe(true);
		const argv = plan.apply.split(" ").slice(4);
		await expectOk(await edit(...argv));
		expect((await one("prio/a")).exclusive).toBe(false);
	});

	test("--description none clears the description and keeps the rest", async () => {
		const { repo, one, edit } = await setup();
		await createLabel(server, repo, "type/epic", {
			description: "A plan",
			exclusive: false,
		});
		await expectOk(await edit("type/epic", "--description", "none"));
		expect(await one("type/epic")).toMatchObject({
			description: "",
			color: "00aabb",
			exclusive: false,
		});
	});

	test("a name in another case edits the one label it matches and returns the stored name", async () => {
		const { repo, one, edit } = await setup();
		await createLabel(server, repo, "Type/Bug");
		const out = await expectOk<Record<string, unknown>>(
			await edit("type/bug", "--color", "ee0701"),
		);
		expect(out).toMatchObject({ changed: true, name: "Type/Bug" });
		expect((await one("Type/Bug")).color).toBe("ee0701");
	});

	test("unknown, ambiguous, duplicate, archived, and spaced targets fail before any write", async () => {
		const { repo, stored, edit } = await setup();
		await createLabel(server, repo, "Bug");
		await createLabel(server, repo, "bug");
		await createLabel(server, repo, "dup");
		await createLabel(server, repo, "dup");
		await createLabel(server, repo, "old", { archived: true });
		await createLabel(server, repo, " spaced ");
		const before = await stored();
		const cases: [string, string, number, string][] = [
			["nope", "usage", 2, "Unknown label"],
			["BUG", "usage", 2, "without case"],
			["dup", "conflict", 5, "2 live labels"],
			["old", "usage", 2, "archived"],
			["spaced", "conflict", 5, "spaces"],
		];
		for (const [name, code, exit, text] of cases) {
			const result = await edit(name, "--color", "000000");
			const err = await expectError(result, code, exit);
			expect({ name, text: err.message.includes(text) }).toEqual({
				name,
				text: true,
			});
			expect(onlyGets(result)).toBe(true);
		}
		expect(await stored()).toEqual(before);
	});

	test("a write token without write:issue fails with auth and changes nothing", async () => {
		const { repo, cwd, stored } = await setup();
		await createLabel(server, repo, "x");
		const before = await stored();
		const result = await runFgj(
			server,
			["write", "label", "edit", "x", "--color", "000000"],
			cwd,
			{ FGJ_WRITE_TOKEN: server.readToken },
		);
		await expectError(result, "auth", 3);
		expect(await stored()).toEqual(before);
	});
});

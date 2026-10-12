import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	adminApi,
	adminSend,
	createIssue,
	createLabel,
	createPull,
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

interface Edited {
	changed: boolean;
	number: number;
	added?: string[];
	removed?: string[];
	dry_run?: true;
	apply?: string;
	as: string;
}

interface ServerIssue {
	title: string;
	body: string;
	labels: { name: string }[];
}

describe("fgj write issue edit", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;
	const ids: Record<string, number> = {};

	/** A pull request, made once: a PR fixture is several writes, too slow for one test. */
	let pull: Awaited<ReturnType<typeof createPull>>;
	let pullDir: string;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		cwd = await makeWorkDir(server, repo);
		ids.bug = await createLabel(server, repo, "type/bug");
		ids.p0 = await createLabel(server, repo, "priority/p0", {
			exclusive: true,
		});
		ids.p1 = await createLabel(server, repo, "priority/p1", {
			exclusive: true,
		});
		ids.old = await createLabel(server, repo, "old/retired", {
			archived: true,
		});
		pull = await createPull(server);
		pullDir = await makeWorkDir(server, pull.repo);
	}, 60_000);

	const edit = (...rest: string[]) =>
		runFgj(server, ["write", "issue", "edit", ...rest], cwd);

	const file = async (name: string, text: string) => {
		const path = join(cwd, name);
		await Bun.write(path, text);
		return path;
	};

	const serverIssue = (n: number) =>
		adminApi<ServerIssue>(
			server,
			`/repos/${repo.owner}/${repo.name}/issues/${n}`,
		);

	const names = async (n: number) =>
		(await serverIssue(n)).labels.map((l) => l.name).sort();

	test("changes the title and the body, returns {changed, number}, and a repeat sends nothing", async () => {
		const n = await createIssue(server, repo, "Old title", { body: "Old." });
		const path = await file("new.md", "New body.\n");
		const out = await expectOk<Edited>(
			await edit(String(n), "--title", "New title", "--body-file", path),
		);
		expect(out).toEqual({ changed: true, number: n, as: "env" });
		expect(await serverIssue(n)).toMatchObject({
			title: "New title",
			body: "New body.\n",
		});
		const result = await edit(
			String(n),
			"--title",
			"New title",
			"--body-file",
			path,
		);
		expect(await expectOk<Edited>(result)).toEqual({
			changed: false,
			number: n,
			as: "env",
		});
		expect(onlyGets(result)).toBe(true);
	});

	test("adds and removes labels by name, and reports only what changed", async () => {
		const n = await createIssue(server, repo, "Labels", {
			labels: [ids.bug as number],
		});
		const out = await expectOk<Edited>(
			await edit(
				String(n),
				"--add-label",
				"priority/p1",
				"--remove-label",
				"Type/Bug",
			),
		);
		expect(out).toMatchObject({
			changed: true,
			added: ["priority/p1"],
			removed: ["type/bug"],
		});
		expect(await names(n)).toEqual(["priority/p1"]);
		const result = await edit(
			String(n),
			"--add-label",
			"priority/p1",
			"--remove-label",
			"type/bug",
		);
		expect(await expectOk<Edited>(result)).toEqual({
			changed: false,
			number: n,
			as: "env",
		});
		expect(onlyGets(result)).toBe(true);
	});

	test("an exclusive label replaces the one of its scope, and the result shows the removed one", async () => {
		const n = await createIssue(server, repo, "Swap", {
			labels: [ids.p0 as number],
		});
		const out = await expectOk<Edited>(
			await edit(String(n), "--add-label", "priority/p1"),
		);
		expect(out).toMatchObject({
			changed: true,
			added: ["priority/p1"],
			removed: ["priority/p0"],
		});
		expect(await names(n)).toEqual(["priority/p1"]);
	});

	test("--dry-run predicts the swap, changes nothing, and gives the apply command", async () => {
		const n = await createIssue(server, repo, "Dry swap", {
			labels: [ids.p0 as number],
		});
		const result = await edit(
			String(n),
			"--add-label",
			"priority/p1",
			"--dry-run",
		);
		const out = await expectOk<Edited>(result);
		expect(out).toMatchObject({
			dry_run: true,
			changed: true,
			added: ["priority/p1"],
			removed: ["priority/p0"],
			apply: `fgj write issue edit ${n} --add-label priority/p1`,
		});
		expect(onlyGets(result)).toBe(true);
		expect(await names(n)).toEqual(["priority/p0"]);
	});

	test("an archived label can be removed but not added", async () => {
		const n = await createIssue(server, repo, "Retire", {
			labels: [ids.old as number],
		});
		const err = await expectError(
			await edit(String(n), "--add-label", "old/retired"),
			"usage",
			2,
		);
		expect(err.message).toContain("archived");
		const out = await expectOk<Edited>(
			await edit(String(n), "--remove-label", "old/retired"),
		);
		expect(out.removed).toEqual(["old/retired"]);
	});

	test("bad label requests fail with usage before any write", async () => {
		const n = await createIssue(server, repo, "Bad labels");
		for (const argv of [
			["--add-label", "type/bugg"],
			["--add-label", "type/bug", "--remove-label", "type/bug"],
			["--add-label", "priority/p0,priority/p1"],
		]) {
			const result = await edit(String(n), ...argv);
			await expectError(result, "usage", 2);
			expect(httpCalls(result).every((c) => c.startsWith("GET"))).toBe(true);
		}
		expect(await names(n)).toEqual([]);
	});

	test("an edit with no change flag fails with usage before any request", async () => {
		const result = await edit("1");
		await expectError(result, "usage", 2);
		expect(httpCalls(result)).toEqual([]);
	});

	test("a missing issue fails with not_found", async () => {
		await expectError(
			await edit("999999", "--title", "Nothing"),
			"not_found",
			4,
		);
	});

	test("a pull request title can be changed", async () => {
		const out = await expectOk<Edited>(
			await runFgj(
				server,
				[
					"write",
					"issue",
					"edit",
					String(pull.number),
					"--title",
					"Renamed PR",
				],
				pullDir,
			),
		);
		expect(out.changed).toBe(true);
		const pr = await adminApi<{ title: string }>(
			server,
			`/repos/${pull.repo.owner}/${pull.repo.name}/issues/${pull.number}`,
		);
		expect(pr.title).toBe("Renamed PR");
	});

	test("a body file is sent byte for byte: the same CRLF bytes are no change, and LF is a change", async () => {
		const n = await createIssue(server, repo, "CRLF body", {
			body: "Line one\r\nLine two\r\n",
		});
		const same = await edit(
			String(n),
			"--body-file",
			await file("crlf.md", "Line one\r\nLine two\r\n"),
		);
		expect(await expectOk<Edited>(same)).toMatchObject({ changed: false });
		expect(onlyGets(same)).toBe(true);
		const lf = await edit(
			String(n),
			"--body-file",
			await file("lf.md", "Line one\nLine two\n"),
		);
		expect(await expectOk<Edited>(lf)).toMatchObject({ changed: true });
		expect((await serverIssue(n)).body).toBe("Line one\nLine two\n");
	});

	/** A milestone in the shared repository, by its title. */
	const milestone = async (title: string, state = "open") => {
		const base = `/repos/${repo.owner}/${repo.name}/milestones`;
		const { id } = await adminApi<{ id: number }>(server, base, { title });
		if (state === "closed") {
			await adminSend(server, "PATCH", `${base}/${id}`, { state });
		}
		return id;
	};

	const milestoneOf = async (n: number) =>
		(
			await adminApi<{ milestone: { id: number } | null }>(
				server,
				`/repos/${repo.owner}/${repo.name}/issues/${n}`,
			)
		).milestone?.id ?? null;

	test("puts many issues in a milestone, one entry each, and a repeat and none behave", async () => {
		const id = await milestone(`Search ${crypto.randomUUID().slice(0, 8)}`);
		const issues = [
			await createIssue(server, repo, "One"),
			await createIssue(server, repo, "Two"),
			await createIssue(server, repo, "Three"),
		];
		const argv = [...issues.map(String), "--milestone", String(id)];
		expect(
			await expectOk<Record<string, unknown>>(await edit(...argv)),
		).toEqual({
			changed: true,
			items: issues.map((number) => ({ number, changed: true })),
			as: "env",
		});
		for (const n of issues) expect(await milestoneOf(n)).toBe(id);
		const repeat = await edit(...argv);
		expect(await expectOk<Record<string, unknown>>(repeat)).toEqual({
			changed: false,
			items: issues.map((number) => ({ number, changed: false })),
			as: "env",
		});
		expect(onlyGets(repeat)).toBe(true);
		const first = issues[0] as number;
		expect(
			await expectOk<Edited>(await edit(String(first), "--milestone", "none")),
		).toEqual({ changed: true, number: first, as: "env" });
		expect(await milestoneOf(first)).toBeNull();
	});

	test("a closed milestone can be set, and labels change on many issues", async () => {
		const id = await milestone(
			`Done ${crypto.randomUUID().slice(0, 8)}`,
			"closed",
		);
		const a = await createIssue(server, repo, "A");
		const b = await createIssue(server, repo, "B", {
			labels: [ids.bug as number],
		});
		const out = await expectOk<Record<string, unknown>>(
			await edit(
				String(a),
				String(b),
				"--milestone",
				String(id),
				"--add-label",
				"type/bug",
			),
		);
		expect(out).toEqual({
			changed: true,
			items: [
				{ number: a, changed: true, added: ["type/bug"] },
				{ number: b, changed: true },
			],
			as: "env",
		});
		expect([await milestoneOf(a), await milestoneOf(b)]).toEqual([id, id]);
		expect(await names(a)).toEqual(["type/bug"]);
	});

	test("--dry-run on many issues changes nothing and gives one apply command", async () => {
		const id = await milestone(`Plan ${crypto.randomUUID().slice(0, 8)}`);
		const a = await createIssue(server, repo, "Plan A");
		const b = await createIssue(server, repo, "Plan B");
		const result = await edit(
			String(a),
			String(b),
			"--milestone",
			String(id),
			"--dry-run",
		);
		expect(await expectOk<Record<string, unknown>>(result)).toEqual({
			dry_run: true,
			changed: true,
			items: [
				{ number: a, changed: true },
				{ number: b, changed: true },
			],
			apply: `fgj write issue edit ${a} ${b} --milestone ${id}`,
			as: "env",
		});
		expect(onlyGets(result)).toBe(true);
		expect([await milestoneOf(a), await milestoneOf(b)]).toEqual([null, null]);
	});

	test("a missing issue among many gets an error entry, and the others still change", async () => {
		const id = await milestone(`Part ${crypto.randomUUID().slice(0, 8)}`);
		const n = await createIssue(server, repo, "Present");
		const result = await edit(String(n), "999999", "--milestone", String(id));
		expect(result.code).toBe(4);
		expect(result.stderr).toBe("");
		const out = JSON.parse(result.stdout) as {
			changed: boolean;
			items: { number: number; changed?: boolean; error?: { code: string } }[];
		};
		expect(out.changed).toBe(true);
		expect(out.items[0]).toEqual({ number: n, changed: true });
		expect(out.items[1]?.error?.code).toBe("not_found");
		expect(await milestoneOf(n)).toBe(id);
	});

	test("--title or --body-file with many issues fails with usage before any request", async () => {
		const path = await file("many.md", "Body.\n");
		for (const argv of [
			["1", "2", "--title", "Same"],
			["1", "2", "--body-file", path],
		]) {
			const result = await edit(...argv);
			await expectError(result, "usage", 2);
			expect(httpCalls(result)).toEqual([]);
		}
	});
});

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	adminApi,
	createLabel,
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

interface Created {
	changed: boolean;
	number: number;
	url?: string;
	dry_run?: true;
	apply?: string;
	as: string;
	[key: string]: unknown;
}

interface ServerIssue {
	number: number;
	title: string;
	body: string;
	labels: { name: string }[];
}

describe("fgj write issue create", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		cwd = await makeWorkDir(server, repo);
		await createLabel(server, repo, "type/bug");
		await createLabel(server, repo, "priority/p0", { exclusive: true });
		await createLabel(server, repo, "priority/p1", { exclusive: true });
		await createLabel(server, repo, "old/retired", { archived: true });
	}, 60_000);

	const create = (...rest: string[]) =>
		runFgj(server, ["write", "issue", "create", ...rest], cwd);

	const body = async (name: string, text: string) => {
		const file = join(cwd, name);
		await Bun.write(file, text);
		return file;
	};

	const serverIssue = (n: number) =>
		adminApi<ServerIssue>(
			server,
			`/repos/${repo.owner}/${repo.name}/issues/${n}`,
		);

	test("creates an issue with a title, a body file, and labels, and returns its number and url only", async () => {
		const file = await body("new.md", "Steps to reproduce.\r\n\n");
		const out = await expectOk<Created>(
			await create(
				"--title",
				"Crash on start",
				"--body-file",
				file,
				"--add-label",
				"Type/Bug,priority/p1",
			),
		);
		expect(Object.keys(out).sort()).toEqual(["as", "changed", "number", "url"]);
		expect(out.changed).toBe(true);
		expect(out.url).toBe(
			`${server.url}/${repo.owner}/${repo.name}/issues/${out.number}`,
		);
		const saved = await serverIssue(out.number);
		expect(saved.title).toBe("Crash on start");
		expect(saved.body).toBe("Steps to reproduce.\r\n\n");
		expect(saved.labels.map((l) => l.name).sort()).toEqual([
			"priority/p1",
			"type/bug",
		]);
	});

	test("a repeat of your latest issue returns changed:false with its number, and creates nothing", async () => {
		const file = await body("retry.md", "Same body.");
		const first = await expectOk<Created>(
			await create("--title", "Retry me", "--body-file", file),
		);
		const result = await create("--title", "Retry me", "--body-file", file);
		const again = await expectOk<Created>(result);
		expect(again).toMatchObject({
			changed: false,
			number: first.number,
			url: first.url,
		});
		expect(httpCalls(result).some((c) => c.startsWith("POST"))).toBe(false);
	});

	test("the same title with another body creates a new issue", async () => {
		const a = await expectOk<Created>(
			await create("--title", "Twin", "--body-file", await body("a.md", "A")),
		);
		const b = await expectOk<Created>(
			await create("--title", "Twin", "--body-file", await body("b.md", "B")),
		);
		expect(b.changed).toBe(true);
		expect(b.number).not.toBe(a.number);
	});

	test("a title alone creates an issue with an empty body, and a repeat is safe", async () => {
		const out = await expectOk<Created>(await create("--title", "Title only"));
		expect((await serverIssue(out.number)).body).toBe("");
		const again = await expectOk<Created>(
			await create("--title", "Title only"),
		);
		expect(again).toMatchObject({ changed: false, number: out.number });
	});

	test("an unknown label fails with usage before the create", async () => {
		const result = await create("--title", "Nope", "--add-label", "type/bugg");
		const err = await expectError(result, "usage", 2);
		expect(err.message).toContain("type/bug");
		expect(onlyGets(result)).toBe(true);
	});

	test("an archived label fails with usage before the create", async () => {
		const result = await create("--title", "Old", "--add-label", "old/retired");
		const err = await expectError(result, "usage", 2);
		expect(err.message).toContain("archived");
		expect(onlyGets(result)).toBe(true);
	});

	test("two labels of one exclusive scope fail with usage before the create", async () => {
		const result = await create(
			"--title",
			"Two priorities",
			"--add-label",
			"priority/p0,priority/p1",
		);
		const err = await expectError(result, "usage", 2);
		expect(err.message).toContain("priority");
		expect(onlyGets(result)).toBe(true);
	});

	test("--dry-run creates nothing, predicts changed, and gives the exact apply command", async () => {
		const file = await body("dry.md", "Planned.");
		const result = await create(
			"--title",
			"Planned issue",
			"--body-file",
			file,
			"--add-label",
			"type/bug",
			"--dry-run",
		);
		const out = await expectOk<Created>(result);
		expect(out).toMatchObject({ dry_run: true, changed: true });
		expect(out.apply).toBe(
			`fgj write issue create --title 'Planned issue' --body-file ${file} --add-label type/bug`,
		);
		expect(onlyGets(result)).toBe(true);
	});

	test("a missing or empty title fails with usage before any request", async () => {
		for (const argv of [[], ["--title", " "]]) {
			const result = await create(...argv);
			await expectError(result, "usage", 2);
			expect(httpCalls(result)).toEqual([]);
		}
	});

	test("an unknown label hint keeps --repo", async () => {
		const err = await expectError(
			await runFgj(
				server,
				[
					"write",
					"issue",
					"create",
					"--title",
					"Hinted",
					"--add-label",
					"nope",
					"--repo",
					`${repo.owner}/${repo.name}`,
				],
				await makeWorkDir(server),
			),
			"usage",
			2,
		);
		expect(err.hint).toBe(
			`fgj read label list --repo ${repo.owner}/${repo.name}`,
		);
	});

	test("a token in --title never reaches the audit log", async () => {
		const result = await create("--title", server.writeToken);
		await expectError(result, "usage", 2);
		const audit = await Bun.file(
			join(cwd, ".local", "state", "fgj", "audit.jsonl"),
		).text();
		expect(audit).not.toContain(server.writeToken);
		expect(audit).toContain("[redacted]");
	});

	test("the repeat check reads only your latest issue, with its labels", async () => {
		const file = await body("latest.md", "Latest.");
		const first = await expectOk<Created>(
			await create("--title", "Latest check", "--body-file", file),
		);
		// A newer issue by someone else does not hide yours.
		const other = await createUser(server);
		await adminApi(
			server,
			`/repos/${repo.owner}/${repo.name}/issues`,
			{ title: "By another user" },
			other,
		);
		expect(
			await expectOk<Created>(
				await create("--title", "Latest check", "--body-file", file),
			),
		).toMatchObject({ changed: false, number: first.number });
		// Other labels are a new request, not a repeat.
		const labelled = await expectOk<Created>(
			await create(
				"--title",
				"Latest check",
				"--body-file",
				file,
				"--add-label",
				"type/bug",
			),
		);
		expect(labelled.changed).toBe(true);
		// Once you open another issue, the first one is no longer your latest.
		await expectOk(await create("--title", "Something else"));
		const again = await expectOk<Created>(
			await create("--title", "Latest check", "--body-file", file),
		);
		expect(again.changed).toBe(true);
		expect(again.number).not.toBe(first.number);
	});

	test("a CRLF body file repeats byte for byte, and its LF version is a new issue", async () => {
		const file = await body("crlf.md", "Line one  \r\nLine two\r\n\r\n");
		const first = await expectOk<Created>(
			await create("--title", "CRLF repeat", "--body-file", file),
		);
		expect((await serverIssue(first.number)).body).toBe(
			"Line one  \r\nLine two\r\n\r\n",
		);
		expect(
			await expectOk<Created>(
				await create("--title", "CRLF repeat", "--body-file", file),
			),
		).toMatchObject({ changed: false, number: first.number });
		const lf = await expectOk<Created>(
			await create(
				"--title",
				"CRLF repeat",
				"--body-file",
				await body("lf.md", "Line one  \nLine two\n\n"),
			),
		);
		expect(lf.changed).toBe(true);
	});

	test("--milestone sets the milestone, and the repeat check compares it", async () => {
		const base = `/repos/${repo.owner}/${repo.name}/milestones`;
		const tag = crypto.randomUUID().slice(0, 8);
		const first = await adminApi<{ id: number }>(server, base, {
			title: `First ${tag}`,
		});
		const second = await adminApi<{ id: number }>(server, base, {
			title: `Second ${tag}`,
		});
		const title = `Milestone ${tag}`;
		const made = await expectOk<Created>(
			await create("--title", title, "--milestone", `first ${tag}`),
		);
		expect(made.changed).toBe(true);
		const stored = await adminApi<{ milestone: { id: number } | null }>(
			server,
			`/repos/${repo.owner}/${repo.name}/issues/${made.number}`,
		);
		expect(stored.milestone?.id).toBe(first.id);
		const repeat = await create(
			"--title",
			title,
			"--milestone",
			String(first.id),
		);
		expect(await expectOk<Created>(repeat)).toMatchObject({
			changed: false,
			number: made.number,
		});
		expect(onlyGets(repeat)).toBe(true);
		const other = await expectOk<Created>(
			await create("--title", title, "--milestone", String(second.id)),
		);
		expect(other.changed).toBe(true);
		expect(other.number).not.toBe(made.number);
		const unknown = await create(
			"--title",
			"No milestone",
			"--milestone",
			"Nope",
		);
		await expectError(unknown, "not_found", 4);
		expect(onlyGets(unknown)).toBe(true);
	});
});

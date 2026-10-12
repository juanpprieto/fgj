import { beforeAll, describe, expect, test } from "bun:test";
import {
	createLabel,
	createRepo,
	expectError,
	expectOk,
	type FixtureRepo,
	loadServer,
	makeWorkDir,
	onlyGets,
	runFgj,
	type TestServer,
} from "../support/forgejo.ts";

interface Label {
	name: string;
	exclusive?: true;
	description?: string;
	color?: string;
}

interface Labels {
	items: Label[];
	next?: string;
	as: string;
}

describe("fgj read label list", () => {
	let server: TestServer;
	let repo: FixtureRepo;
	let cwd: string;

	beforeAll(async () => {
		server = await loadServer();
		repo = await createRepo(server);
		cwd = await makeWorkDir(server, repo);
		await createLabel(server, repo, "domain/api", {
			description: "The HTTP API",
		});
		await createLabel(server, repo, "priority/p0", { exclusive: true });
		await createLabel(server, repo, "priority/p1", { exclusive: true });
		await createLabel(server, repo, "old/retired", { archived: true });
	}, 60_000);

	const list = (dir: string, ...rest: string[]) =>
		runFgj(server, ["read", "label", "list", ...rest], dir);

	test("returns every live label by name, marks only exclusive ones, and omits archived ones", async () => {
		const result = await list(cwd);
		const out = await expectOk<Labels>(result);
		const byName = (a: Label, b: Label) => a.name.localeCompare(b.name);
		expect([...out.items].sort(byName)).toEqual([
			{ name: "domain/api" },
			{ name: "priority/p0", exclusive: true },
			{ name: "priority/p1", exclusive: true },
		]);
		expect(Object.keys(out).sort()).toEqual(["as", "items"]);
		expect(onlyGets(result)).toBe(true);
	});

	test("--fields adds the description", async () => {
		const out = await expectOk<Labels>(
			await list(cwd, "--fields", "name,description"),
		);
		expect(out.items.find((l) => l.name === "domain/api")).toEqual({
			name: "domain/api",
			description: "The HTTP API",
		});
	});

	test("--fields adds the color as six lowercase hex digits, and the field list names it", async () => {
		const out = await expectOk<Labels>(
			await list(cwd, "--fields", "name,color,description,exclusive"),
		);
		expect(out.items.find((l) => l.name === "domain/api")).toEqual({
			name: "domain/api",
			color: "00aabb",
			description: "The HTTP API",
		});
		expect(out.items.find((l) => l.name === "priority/p0")).toEqual({
			name: "priority/p0",
			color: "00aabb",
			exclusive: true,
		});
		const fields = await expectOk<{ fields: string[]; default: string[] }>(
			await list(cwd, "--fields"),
		);
		expect(fields.fields).toContain("color");
		expect(fields.default).toEqual(["name", "exclusive"]);
	});

	test("reads every page past the server's page limit", async () => {
		const big = await createRepo(server);
		// Two full server pages and one more: fgj must read three pages.
		const count = server.apiPage * 2 + 1;
		for (let i = 0; i < count; i++) {
			await createLabel(server, big, `area/${String(i).padStart(2, "0")}`);
		}
		const out = await expectOk<Labels>(
			await list(await makeWorkDir(server, big)),
		);
		expect(out.items).toHaveLength(count);
	});

	test("a repository with no labels returns an empty list", async () => {
		const empty = await createRepo(server);
		const out = await expectOk<Labels>(
			await list(await makeWorkDir(server, empty)),
		);
		expect(out.items).toEqual([]);
	});

	test("a repository that does not exist fails with not_found", async () => {
		await expectError(
			await list(cwd, "--repo", `${repo.owner}/nope-${Date.now()}`),
			"not_found",
			4,
		);
	});
});

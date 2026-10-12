import { describe, expect, test } from "bun:test";
import { main } from "../../src/core/dispatch.ts";
import type { FgjError } from "../../src/core/errors.ts";
import {
	type ApiLabel,
	type LabelEditInput,
	labelCreate,
	labelEdit,
	resolveLabels,
} from "../../src/verbs/label.ts";

const label = (name: string, extra: Partial<ApiLabel> = {}): ApiLabel => ({
	id: name.length,
	name,
	color: "000000",
	exclusive: false,
	is_archived: false,
	description: "",
	...extra,
});

const LABELS = [
	label("priority/p0", { exclusive: true }),
	label("priority/p1", { exclusive: true }),
	label("domain/api"),
	label("Bug"),
	label("bug"),
	label("old/retired", { is_archived: true }),
];

function refusal(fn: () => unknown): FgjError {
	try {
		fn();
	} catch (err) {
		return err as FgjError;
	}
	throw new Error("expected a refusal");
}

describe("resolveLabels", () => {
	test("an exact name wins, and a unique match ignores case", () => {
		expect(
			resolveLabels(LABELS, ["domain/api", "Priority/P1"], "h").map(
				(l) => l.name,
			),
		).toEqual(["domain/api", "priority/p1"]);
		expect(resolveLabels(LABELS, ["Bug"], "h").map((l) => l.name)).toEqual([
			"Bug",
		]);
	});

	test("a name that matches two labels only without case is refused", () => {
		const err = refusal(() => resolveLabels(LABELS, ["BUG"], "h"));
		expect(err.code).toBe("usage");
		expect(err.message).toContain("Bug");
		expect(err.message).toContain("bug");
	});

	test("an unknown name is refused with close names and the label list hint", () => {
		const err = refusal(() => resolveLabels(LABELS, ["priority/p2"], "h"));
		expect(err.code).toBe("usage");
		expect(err.message).toContain("priority/p0");
		expect(err.message).toContain("organization");
		expect(err.hint).toBe("fgj read label list");
	});

	test("an archived label resolves only when allowed", () => {
		expect(
			resolveLabels(LABELS, ["old/retired"], "h", { archived: true }).map(
				(l) => l.name,
			),
		).toEqual(["old/retired"]);
		const err = refusal(() => resolveLabels(LABELS, ["old/retired"], "h"));
		expect(err.message).toContain("archived");
	});

	test("an archived label does not make a live label's name ambiguous", () => {
		const labels = [label("Old", { is_archived: true }), label("old")];
		expect(resolveLabels(labels, ["OLD"], "h").map((l) => l.name)).toEqual([
			"old",
		]);
	});

	test("the unknown-label hint is the list command that the caller gives", () => {
		const err = refusal(() =>
			resolveLabels(LABELS, ["nope"], "h", {
				listHint: "fgj read label list --repo a/b",
			}),
		);
		expect(err.hint).toBe("fgj read label list --repo a/b");
	});
});

/** Runs fgj in-process with no host or token, so only local checks can answer. */
async function fgj(...argv: string[]) {
	let stderr = "";
	const code = await main(argv, {
		cwd: "/nonexistent-fgj-test",
		env: {},
		stdout: () => {},
		stderr: (t) => {
			stderr += t;
		},
	});
	return { code, error: stderr ? JSON.parse(stderr).error : undefined };
}

describe("label create: local checks before any request", () => {
	const create = (...argv: string[]) =>
		fgj("write", "label", "create", ...argv);

	test("a missing or blank name, or a positional argument, is a usage error", async () => {
		for (const argv of [
			["--color", "000000"],
			["--name", "  ", "--color", "000000"],
			["type/epic", "--color", "000000"],
		]) {
			const r = await create(...argv);
			expect({ argv, code: r.code, err: r.error.code }).toEqual({
				argv,
				code: 2,
				err: "usage",
			});
			expect(r.error.message).not.toContain("Unknown verb");
		}
	});

	test("a color is exactly six hex digits; a # gets the shell-comment hint", async () => {
		const hash = await create("--name", "x", "--color", "#5319e7");
		expect(hash.code).toBe(2);
		expect(hash.error.message).toContain("shell comment");
		for (const color of ["fff", "5319e", "5319e7a", "zzzzzz", ""]) {
			const r = await create("--name", "x", "--color", color);
			expect({ color, code: r.code }).toEqual({ color, code: 2 });
		}
		const missing = await create("--name", "x");
		expect(missing.code).toBe(2);
	});

	test("a description is one line", async () => {
		const r = await create(
			"--name",
			"x",
			"--color",
			"000000",
			"--description",
			"two\nlines",
		);
		expect(r.code).toBe(2);
		expect(r.error.message).toContain("one line");
	});

	test("--exclusive needs a scoped name such as priority/high", async () => {
		for (const name of ["plain", "/high", "priority/"]) {
			const r = await create(
				"--name",
				name,
				"--color",
				"000000",
				"--exclusive",
			);
			expect({ name, code: r.code }).toEqual({ name, code: 2 });
			expect(r.error.message).toContain("scope");
		}
		// The scope ends at the last slash, as in Forgejo and issue edit.
		for (const name of ["a/b/", "a//"]) {
			const r = await create(
				"--name",
				name,
				"--color",
				"000000",
				"--exclusive",
			);
			expect({ name, code: r.code }).toEqual({ name, code: 2 });
		}
		const nested = await create(
			"--name",
			"/a/b",
			"--color",
			"000000",
			"--exclusive",
		);
		expect(nested.error.code).not.toBe("usage");
	});

	test("a name with a comma is refused, because --add-label splits on commas", async () => {
		const r = await create("--name", "a,b", "--color", "000000");
		expect(r.code).toBe(2);
		expect(r.error.message).toContain("comma");
	});

	test("valid input passes the local checks and stops only at the missing host", async () => {
		const r = await create(
			"--name",
			"priority/high",
			"--color",
			"B60205",
			"--description",
			"Do it first",
			"--exclusive",
		);
		expect(r.error.code).not.toBe("usage");
	});
});

describe("label create: the conflict message", () => {
	test("a stored description that the server leaves out reads as empty, not null", async () => {
		const stored = {
			...label("type/epic"),
			color: "5319e7",
		} as Partial<ApiLabel>;
		delete stored.description;
		const api = {
			list: async () => ({ items: [stored], total: 1 }),
		};
		const ctx = {
			target: { owner: "o", name: "r", baseUrl: "https://x.test" },
			api,
			commandFor: () => "fgj read label list",
			commandWith: () => "",
		};
		const err = await labelCreate
			.run(
				{
					name: "type/epic",
					color: "5319e7",
					description: "New",
					exclusive: false,
					dryRun: false,
				},
				ctx as never,
			)
			.then(
				() => undefined,
				(e: FgjError) => e,
			);
		expect(err?.code).toBe("conflict");
		expect(err?.message).toContain('description ""');
		expect(err?.message).not.toContain("undefined");
	});
});

describe("label edit: local checks before any request", () => {
	const edit = (...argv: string[]) => fgj("write", "label", "edit", ...argv);

	const usage = async (argv: string[], text: string) => {
		const r = await edit(...argv);
		expect({ argv, code: r.code, err: r.error.code }).toEqual({
			argv,
			code: 2,
			err: "usage",
		});
		expect({ argv, text: r.error.message.includes(text) }).toEqual({
			argv,
			text: true,
		});
	};

	test("one label is needed, and at least one field to change", async () => {
		await usage(["--color", "000000"], "Missing the label");
		await usage(["a", "b", "--color", "000000"], "one label");
		await usage(["type/epic"], "Nothing to change");
		await usage(["  ", "--color", "000000"], "Missing the label");
	});

	test("a color is six hex digits; a # gets the shell-comment hint", async () => {
		await usage(["x", "--color", "#5319e7"], "shell comment");
		for (const color of ["fff", "5319e7a", "zzzzzz"]) {
			await usage(["x", "--color", color], "six hex digits");
		}
	});

	test("a description is one line, and a blank one points to none", async () => {
		await usage(["x", "--description", "two\nlines"], "one line");
		await usage(["x", "--description", "   "], "--description none");
	});

	test("--exclusive needs a scoped name, and it cannot come with --no-exclusive", async () => {
		for (const name of ["plain", "/high", "priority/"]) {
			await usage([name, "--exclusive"], "scope");
		}
		await usage(["p/a", "--exclusive", "--no-exclusive"], "--no-exclusive");
		// Turning exclusivity off needs no scope.
		const off = await edit("plain", "--no-exclusive");
		expect(off.error.code).not.toBe("usage");
	});

	test("a label name with spaces around it is refused", async () => {
		await usage([" p/a", "--color", "000000"], "spaces");
	});

	test("valid input passes the local checks and stops only at the missing host", async () => {
		const r = await edit(
			"Priority/P1",
			"--color",
			"D93F0B",
			"--description",
			"none",
			"--exclusive",
		);
		expect(r.error.code).not.toBe("usage");
	});
});

describe("label edit: what it sends", () => {
	/** Runs label edit against fixed labels and records each write. */
	async function run(
		stored: ApiLabel,
		input: Partial<LabelEditInput>,
		others: ApiLabel[] = [],
	): Promise<{ out: unknown; sent: unknown[] }> {
		const sent: unknown[] = [];
		const items = [...others, stored];
		const api = {
			list: async () => ({ items, total: items.length }),
			send: async (method: string, path: string, body: unknown) => {
				sent.push({ method, path, body });
				return stored;
			},
			assertSendable: () => {},
		};
		const ctx = {
			target: { owner: "o", name: "r", baseUrl: "https://x.test" },
			api,
			commandFor: () => "fgj read label list",
			commandWith: () => "apply",
		};
		const out = await labelEdit.run(
			{
				label: stored.name,
				color: undefined,
				description: undefined,
				exclusive: undefined,
				dryRun: false,
				...input,
			},
			ctx as never,
		);
		return { out, sent };
	}

	test("it sends only the fields that differ", async () => {
		const stored = label("p/a", { color: "00aabb", description: "Keep" });
		const r = await run(stored, {
			color: "00aabb",
			description: "Keep",
			exclusive: true,
		});
		expect(r.sent).toEqual([
			{
				method: "PATCH",
				path: "/repos/o/r/labels/3",
				body: { exclusive: true },
			},
		]);
		expect(r.out).toEqual({ changed: true, name: "p/a" });
	});

	test("a description the server leaves out compares as empty", async () => {
		const stored = label("p/a") as Partial<ApiLabel>;
		delete stored.description;
		const r = await run(stored as ApiLabel, { description: "" });
		expect(r.sent).toEqual([]);
		expect(r.out).toEqual({ changed: false, name: "p/a" });
	});

	test("an archived label with the exact name does not hide the live one", async () => {
		const live = label("dup", { id: 7 });
		const archived = label("dup", { id: 6, is_archived: true });
		const r = await run(live, { color: "ffffff" }, [archived]);
		expect(r.sent).toEqual([
			{
				method: "PATCH",
				path: "/repos/o/r/labels/7",
				body: { color: "ffffff" },
			},
		]);
	});

	test("an archived label alone fails as archived, and sends nothing", async () => {
		const archived = label("old", { is_archived: true });
		const err = await run(archived, { color: "ffffff" }).then(
			() => undefined,
			(e: FgjError) => e,
		);
		expect(err?.code).toBe("usage");
		expect(err?.message).toContain("archived");
	});

	test("an archived exact name does not block the one live label that matches without case", async () => {
		const live = label("Bug", { id: 9 });
		const archived = label("bug", { id: 8, is_archived: true });
		const r = await run(live, { label: "bug", color: "ffffff" }, [archived]);
		expect(r.sent).toEqual([
			{
				method: "PATCH",
				path: "/repos/o/r/labels/9",
				body: { color: "ffffff" },
			},
		]);
		expect(r.out).toEqual({ changed: true, name: "Bug" });
	});
});

import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/core/args.ts";
import type { FgjError } from "../../src/core/errors.ts";
import { truncateBody } from "../../src/core/output.ts";
import { createRedactor } from "../../src/core/redact.ts";
import type { Verb } from "../../src/core/verb.ts";
import { commentAdd, commentList } from "../../src/verbs/comment.ts";
import {
	authorName,
	COMMENT_ARG_SHAPE,
	commentRef,
	issueRef,
} from "../../src/verbs/common.ts";

const verb = commentList as Verb;
const hint = "fgj help comment list --json";

describe("parseArgs", () => {
	test("accepts --name=value and --name value", () => {
		expect(parseArgs(["1", "--limit=5"], verb).flags).toEqual({ limit: 5 });
		expect(parseArgs(["1", "--limit", "5"], verb).flags).toEqual({ limit: 5 });
	});

	test("ignores --json, because output is always JSON", () => {
		expect(parseArgs(["1", "--json"], verb)).toEqual({
			positionals: ["1"],
			flags: {},
		});
	});

	test("rejects a short flag instead of counting it as an argument", () => {
		expect(() => parseArgs(["1", "-n", "5"], verb)).toThrow(
			/Unknown flag -n\. fgj uses long flags only/,
		);
	});

	test("an unknown flag lists the valid flags", () => {
		expect(() => parseArgs(["1", "--state", "open"], verb)).toThrow(
			/Valid flags: --limit, --offset, --last/,
		);
	});
});

describe("flag values", () => {
	test("a bool flag with a value is refused, not silently set", () => {
		expect(() =>
			parseArgs(
				["1", "--body-file", "x", "--dry-run=false"],
				commentAdd as Verb,
			),
		).toThrow(/--dry-run takes no value/);
	});
});

describe("issueRef", () => {
	const ref = (...positionals: string[]) =>
		issueRef({ positionals, flags: {} }, hint);

	test("accepts 157 and #157, with 157 as the canonical form", () => {
		expect(ref("157")).toEqual({ number: 157, canonical: "157" });
		expect(ref("#157")).toEqual({ number: 157, canonical: "157" });
	});

	test("accepts an issue or PR URL, drops the fragment, and keeps the kind", () => {
		expect(ref("https://git.example.com/o/r/pulls/9#issuecomment-4")).toEqual({
			number: 9,
			remote: { baseUrl: "https://git.example.com", owner: "o", name: "r" },
			canonical: "https://git.example.com/o/r/pulls/9",
		});
	});

	test("no argument explains the unquoted # shell comment", () => {
		expect(() => ref()).toThrow(/unquoted # starts a shell comment/);
	});

	test("rejects zero, text, and a number past the safe integer range", () => {
		expect(() => ref("9007199254740993")).toThrow(/issue number or issue URL/);
		expect(() => ref("0")).toThrow(/issue number or issue URL/);
		expect(() => ref("abc")).toThrow(/issue number or issue URL/);
	});
});

describe("commentRef", () => {
	const ref = (...positionals: string[]) =>
		commentRef({ positionals, flags: {} }, hint);

	test("an id past the safe integer range is refused, not rounded", () => {
		expect(() => ref("9007199254740993")).toThrow(/comment id or comment URL/);
		expect(() => ref("1000000000000000000000")).toThrow(
			/comment id or comment URL/,
		);
	});

	test("accepts an id and an issuecomment fragment, with the id as the canonical form", () => {
		for (const raw of ["770", "issuecomment-770", "#issuecomment-770"]) {
			expect(ref(raw)).toEqual({ id: 770, canonical: "770" });
		}
	});

	test("accepts a comment URL on an issue or a PR, and names its repository", () => {
		const remote = {
			baseUrl: "https://git.example.com",
			owner: "o",
			name: "r",
		};
		for (const raw of [
			"https://git.example.com/o/r/issues/4#issuecomment-770",
			"https://git.example.com/o/r/pulls/4#issuecomment-770",
		]) {
			expect(ref(raw)).toEqual({
				id: 770,
				issue: 4,
				remote,
				canonical: "https://git.example.com/o/r/issues/4#issuecomment-770",
			});
		}
	});

	test("an issue URL with no comment fragment points at comment list", () => {
		expect(() => ref("https://git.example.com/o/r/issues/4")).toThrow(
			/names issue 4, not a comment/,
		);
		try {
			ref("https://git.example.com/o/r/issues/4");
		} catch (err) {
			expect((err as FgjError).hint).toBe(
				"fgj read comment list https://git.example.com/o/r/issues/4",
			);
		}
	});

	test("#770 is refused, because # names an issue", () => {
		expect(() => ref("#770")).toThrow(/#770 names an issue/);
	});

	test("rejects no argument, two arguments, zero, and text", () => {
		expect(() => ref()).toThrow(/Missing the comment id/);
		expect(() => ref("1", "2")).toThrow(/one comment id/);
		expect(() => ref("0")).toThrow(/comment id or comment URL/);
		expect(() => ref("abc")).toThrow(/comment id or comment URL/);
	});
});

describe("COMMENT_ARG_SHAPE", () => {
	test("matches exactly the arguments that commentRef accepts", () => {
		const shape = new RegExp(COMMENT_ARG_SHAPE);
		for (const raw of [
			"770",
			"issuecomment-770",
			"#issuecomment-770",
			"https://h.example/o/r/issues/4#issuecomment-770",
			"https://h.example/o/r/pulls/4#issuecomment-770",
			"",
			"0770",
			"abc",
			"#770",
			"770#x",
			"123456789012345678",
			"https://h.example/o/r/issues/4",
			"-h",
		]) {
			let accepted = true;
			try {
				commentRef({ positionals: [raw], flags: {} }, hint);
			} catch {
				accepted = false;
			}
			expect({ raw, shape: shape.test(raw) }).toEqual({ raw, shape: accepted });
		}
	});
});

describe("truncateBody", () => {
	test("leaves a short body with no markers", () => {
		expect(truncateBody("abc", 3)).toEqual({ body: "abc" });
		expect(truncateBody(null, 3)).toEqual({ body: "" });
	});

	test("counts code points, so a cut never splits an emoji", () => {
		// Each emoji is 2 UTF-16 units but 1 character.
		expect(truncateBody("😀😀😀", 3)).toEqual({ body: "😀😀😀" });
		expect(truncateBody("😀😀😀", 2)).toEqual({
			body: "😀😀",
			body_truncated: true,
			body_chars: 3,
		});
	});
});

describe("createRedactor", () => {
	test("replaces every registered secret and ignores short values", () => {
		const r = createRedactor();
		r.add("secret-token-123");
		r.add("abc");
		r.add(undefined);
		expect(r.apply("a secret-token-123 b secret-token-123 abc")).toBe(
			"a [redacted] b [redacted] abc",
		);
	});
});

describe("authorName", () => {
	test("a migrated comment names its original author", () => {
		expect(
			authorName({ original_author: "gh-alice", user: { login: "Ghost" } }),
		).toBe("gh-alice");
	});

	test("a normal comment names its user; no user gives null", () => {
		expect(authorName({ original_author: "", user: { login: "bob" } })).toBe(
			"bob",
		);
		expect(authorName({ original_author: "", user: null })).toBeNull();
	});
});

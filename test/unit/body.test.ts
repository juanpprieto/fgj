import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readBodyFile } from "../../src/verbs/common.ts";
import { tempDir } from "../support/tmp.ts";

describe("readBodyFile", () => {
	const dir = tempDir("fgj-body-");
	const local = { cwd: dir, home: undefined };
	const write = (name: string, bytes: Uint8Array | string) => {
		writeFileSync(join(dir, name), bytes);
		return name;
	};

	test("returns the text exactly: CRLF, trailing spaces, a final newline, and a BOM", () => {
		const text = "﻿Line one  \r\nLine two\r\n\r\n";
		expect(readBodyFile(write("exact.md", text), local, "h")).toBe(text);
	});

	test("a file that is not UTF-8 fails instead of changing bytes", () => {
		const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
		expect(() => readBodyFile(write("latin1.md", latin1), local, "h")).toThrow(
			"not UTF-8",
		);
	});

	test("a blank file fails", () => {
		expect(() =>
			readBodyFile(write("blank.md", " \r\n\t\n"), local, "h"),
		).toThrow("empty");
	});
});

import { describe, expect, test } from "bun:test";
import { readWindow } from "../../src/verbs/issue.ts";

/** A fake list endpoint over 0..count-1 that caps each page at `max` items. */
function server(count: number, max: number) {
	const calls: string[] = [];
	const all = Array.from({ length: count }, (_, i) => i);
	const fetchPage = async (page: number, limit: number) => {
		calls.push(`${page}/${limit}`);
		const size = Math.min(limit, max);
		return { items: all.slice((page - 1) * size, page * size), total: count };
	};
	const serverMax = async () => {
		calls.push("settings");
		return max;
	};
	return { fetchPage, serverMax, calls };
}

describe("readWindow", () => {
	test("reads the pages that cover the offset and limit, with no settings read on page 1", async () => {
		const s = server(120, 50);
		expect(await readWindow(s.fetchPage, 5, 10, s.serverMax)).toEqual({
			items: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
			total: 120,
		});
		expect(s.calls).toEqual(["1/50"]);
	});

	test("an offset past page 1 reads the server's page size once", async () => {
		const s = server(120, 50);
		expect(await readWindow(s.fetchPage, 55, 10, s.serverMax)).toEqual({
			items: [55, 56, 57, 58, 59, 60, 61, 62, 63, 64],
			total: 120,
		});
		expect(s.calls).toEqual(["settings", "2/50"]);
	});

	test("every offset and limit returns the exact slice, whatever the server's page size", async () => {
		const wrong: string[] = [];
		for (const max of [1, 7, 30, 49, 50, 51, 100]) {
			for (let count = 0; count <= 160; count++) {
				for (const offset of [
					0, 1, 29, 30, 49, 50, 51, 60, 99, 100, 150, 170,
				]) {
					for (const limit of [1, 10, 50, 100]) {
						const s = server(count, max);
						const got = await readWindow(
							s.fetchPage,
							offset,
							limit,
							s.serverMax,
						);
						const want = Array.from(
							{ length: Math.max(0, Math.min(limit, count - offset)) },
							(_, i) => offset + i,
						);
						if (
							JSON.stringify(got) !==
							JSON.stringify({ items: want, total: count })
						) {
							wrong.push(
								`count ${count} max ${max} offset ${offset} limit ${limit}`,
							);
						}
					}
				}
			}
		}
		expect(wrong.slice(0, 5)).toEqual([]);
	});

	test("a missing page size from the server fails instead of returning nothing", async () => {
		const s = server(120, 50);
		await expect(
			readWindow(s.fetchPage, 60, 10, async () => Number.NaN),
		).rejects.toThrow("max_response_items");
	});
});

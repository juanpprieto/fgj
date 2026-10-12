import { FgjError } from "./errors.ts";
import type { FieldSpec, FlagValue } from "./verb.ts";

/** The most characters fgj prints in one result. Harnesses cut read-back at 30k. */
export const OUTPUT_CAP = 28_000;

/** The default `--body-max`. */
export const BODY_MAX_DEFAULT = 4000;

/** The largest `--body-max`. One item at this size still fits under the cap. */
export const BODY_MAX_LIMIT = 20_000;

/** The default and the largest `--limit` for lists. */
export const LIST_LIMIT_DEFAULT = 20;
export const LIST_LIMIT_MAX = 100;

/** Room that the list envelope (`total`, `next`, `hint`, `note`) can take. */
const ENVELOPE_RESERVE = 1000;

/** The most characters one list item may take once serialized as JSON. */
export const ITEM_BUDGET = OUTPUT_CAP - ENVELOPE_RESERVE;

/**
 * Cuts an item's body further until the item, serialized as JSON, fits in
 * `budget`. JSON escaping can double a body (quotes, backslashes, new lines), so
 * a body under `--body-max` can still pass the output cap.
 *
 * @param item - An output item with an optional string `body`.
 * @param budget - The most JSON characters the item may take.
 * @returns The item, or a copy with a shorter body, `body_truncated`, and `body_chars`.
 * @example
 * fitItem({ id: 1, body: "\\".repeat(20000) }, 27000).body_truncated; // true
 */
export function fitItem(
	item: Record<string, unknown>,
	budget: number = ITEM_BUDGET,
): Record<string, unknown> {
	if (JSON.stringify(item).length <= budget || typeof item.body !== "string") {
		return item;
	}
	const chars = Array.from(item.body);
	const total =
		typeof item.body_chars === "number" ? item.body_chars : chars.length;
	const withBody = (n: number) => ({
		...item,
		body: chars.slice(0, n).join(""),
		body_truncated: true,
		body_chars: total,
	});
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (JSON.stringify(withBody(mid)).length <= budget) low = mid;
		else high = mid - 1;
	}
	return withBody(low);
}

/** A body after truncation, ready to spread into an output item. */
export type BodyOut =
	| { body: string }
	| { body: string; body_truncated: true; body_chars: number };

/**
 * Cuts a body to `max` characters, counted in Unicode code points so a cut never
 * splits an emoji. Only a cut body carries `body_truncated` and `body_chars`.
 *
 * @param body - The full body text. `null` from the API counts as empty.
 * @param max - The most characters to keep, from `--body-max`.
 * @returns The body, plus the markers and the full length when the body was cut.
 * @example
 * truncateBody("abcdef", 3); // { body: "abc", body_truncated: true, body_chars: 6 }
 */
export function truncateBody(body: string | null, max: number): BodyOut {
	const text = body ?? "";
	if (text.length <= max) return { body: text };
	const chars = Array.from(text);
	if (chars.length <= max) return { body: text };
	return {
		body: chars.slice(0, max).join(""),
		body_truncated: true,
		body_chars: chars.length,
	};
}

/**
 * Reads `--fields` into the list of fields to print. It checks names locally.
 *
 * @param flag - The raw `--fields` value: a comma list, or undefined for the default.
 * @param spec - The fields that the verb supports.
 * @param hint - The help command to show when a name is unknown.
 * @returns The selected field names, in the order the caller gave.
 * @throws {FgjError} A usage error that lists the valid names.
 * @example
 * selectFields("id,body", { all: ["id", "author", "body"], default: ["id"] }, "fgj help comment list");
 * // ["id", "body"]
 */
export function selectFields(
	flag: FlagValue | undefined,
	spec: FieldSpec,
	hint: string,
): readonly string[] {
	if (flag === undefined) return spec.default;
	const names = String(flag)
		.split(",")
		.map((n) => n.trim())
		.filter(Boolean);
	const unknown = names.filter((n) => !spec.all.includes(n));
	if (unknown.length > 0 || names.length === 0) {
		throw new FgjError(
			"usage",
			`Unknown field ${unknown.join(", ") || "(empty)"}. Valid fields: ${spec.all.join(", ")}.`,
			hint,
		);
	}
	return names;
}

/**
 * Keeps only the selected fields of one item. The `body` field brings its
 * truncation markers with it.
 *
 * @param item - The full item that the verb built.
 * @param fields - The names from {@link selectFields}.
 * @returns A new object with the selected keys in the item's own order.
 * @example
 * pick({ id: 1, author: "a", body: "x" }, ["body"]);
 * // { body: "x" }
 */
export function pick(
	item: Record<string, unknown>,
	fields: readonly string[],
): Record<string, unknown> {
	const keep = new Set(fields);
	if (keep.has("body")) {
		keep.add("body_truncated");
		keep.add("body_chars");
	}
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(item)) {
		if (keep.has(key) && value !== undefined) out[key] = value;
	}
	return out;
}

/** One page of a list. `next` is the exact command for the next page, or null at the end. */
export interface Page<T> {
	items: T[];
	total: number;
	next: string | null;
	hint?: string;
}

/**
 * Takes up to `limit` items from `offset`, and stops early before the output
 * passes {@link OUTPUT_CAP}. It always keeps at least one item.
 *
 * @param all - Every item, already shaped for output.
 * @param offset - The index of the first item, from `--offset`.
 * @param limit - The most items to return, from `--limit`.
 * @param nextCommand - Builds the exact fgj command for the page at a new offset.
 * @returns The page, with `total` and, when more items exist, `next`.
 * @example
 * page(items, 0, 20, (o) => `fgj read comment list 5 --offset ${o}`);
 */
export function page<T>(
	all: readonly T[],
	offset: number,
	limit: number,
	nextCommand: (offset: number) => string,
): Page<T> {
	const items: T[] = [];
	let size = ENVELOPE_RESERVE;
	for (let i = offset; i < all.length && items.length < limit; i++) {
		const itemSize = JSON.stringify(all[i]).length + 1;
		if (items.length > 0 && size + itemSize > OUTPUT_CAP) break;
		items.push(all[i] as T);
		size += itemSize;
	}
	const end = offset + items.length;
	const next = end < all.length ? nextCommand(end) : null;
	return { items, total: all.length, next };
}

/**
 * Serializes a result as one line of compact JSON.
 *
 * @param value - The result object.
 * @returns The JSON text with a trailing newline.
 * @example
 * toLine({ changed: true }); // '{"changed":true}\n'
 */
export function toLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

import { createHash } from "node:crypto";
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
 * Fits one body part after JSON escaping, preserving an exact continuation.
 * @param item - Selected output fields, with the full unmodified body when selected.
 * @param part - Part size, optional cursor, and the command that restarts this body.
 * @param budget - Maximum serialized item size, reserving space for its envelope.
 * @returns A bounded item with body_next when more text remains.
 * @example
 * fitItem({ body: "abcdef" }, { max: 3, command: "fgj read issue get 1" }).body; // "abc"
 */
export function fitItem(
	item: Record<string, unknown>,
	part: { max: number; after?: string | undefined; command: string },
	budget: number = ITEM_BUDGET,
): Record<string, unknown> {
	if (typeof item.body !== "string") {
		if (JSON.stringify(item).length > budget)
			throw new FgjError(
				"usage",
				"Selected metadata exceeds the output cap; select fewer fields.",
				part.command,
			);
		return item;
	}
	const chars = Array.from(item.body);
	const revision = createHash("sha256").update(item.body).digest("hex");
	const [expected, rawOffset] = part.after?.split(":") ?? [];
	const offset = Number(rawOffset ?? 0);
	if (expected !== undefined && expected !== revision) {
		throw new FgjError(
			"conflict",
			"Body changed while reading. Discard its earlier parts and restart this body.",
			part.command,
		);
	}
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		(part.after !== undefined && offset >= chars.length)
	) {
		throw new FgjError(
			"usage",
			"Body offset is outside this body. Restart the read.",
			part.command,
		);
	}
	const shown = (n: number) => ({
		...item,
		body: chars.slice(offset, offset + n).join(""),
		...(offset > 0 || offset + n < chars.length
			? {
					body_offset: offset,
					body_chars: chars.length,
					body_revision: revision,
				}
			: {}),
		...(offset + n < chars.length
			? {
					body_truncated: true,
					body_next: `${part.command} --body-after ${revision}:${offset + n}`,
				}
			: {}),
	});
	let low = 0;
	let high = Math.min(part.max, chars.length - offset);
	if (JSON.stringify(shown(high)).length <= budget) return shown(high);
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (JSON.stringify(shown(mid)).length <= budget) low = mid;
		else high = mid - 1;
	}
	const result = shown(low);
	if (
		(low === 0 && offset < chars.length) ||
		JSON.stringify(result).length > budget
	) {
		throw new FgjError(
			"usage",
			"Selected metadata leaves no room for a body part; select fewer fields.",
			part.command,
		);
	}
	return result;
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
 * Keeps only the selected fields of one item.
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

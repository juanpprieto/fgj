import { FgjError } from "../core/errors.ts";
import { page, pick, selectFields } from "../core/output.ts";
import type { ParsedArgs, ReadVerb, WriteVerb } from "../core/verb.ts";
import type { ReadApi } from "../forgejo/client.ts";
import type { Target } from "../forgejo/target.ts";
import { DRY_RUN_FLAG, REPO_FLAG, rangeFlag } from "./common.ts";

/** A Forgejo label, reduced to the keys fgj reads. */
export interface ApiLabel {
	id: number;
	name: string;
	/** Six lowercase hex digits, with no `#`. */
	color: string;
	exclusive: boolean;
	is_archived: boolean;
	description: string;
}

/** Forgejo's largest page for label lists. */
const LABEL_PAGE = 50;

/**
 * Reads every label of a repository, archived ones too, across all pages.
 *
 * @param api - A client that can send GET.
 * @param target - The repository.
 * @returns The labels in the server's order.
 * @throws {FgjError} not_found when the repository does not exist.
 * @example
 * const labels = await repoLabels(api, target);
 */
export async function repoLabels(
	api: Pick<ReadApi, "list">,
	target: Target,
): Promise<ApiLabel[]> {
	const path = `/repos/${target.owner}/${target.name}/labels`;
	const all: ApiLabel[] = [];
	// Stop at the total, not at a short page: a server can page below 50.
	for (let p = 1; ; p++) {
		const { items, total } = await api.list<ApiLabel>(path, {
			limit: LABEL_PAGE,
			page: p,
		});
		all.push(...items);
		if (items.length === 0 || all.length >= total) return all;
	}
}

/** The edit distance between two short strings. */
function distance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(
				(prev[j] as number) + 1,
				(row[j - 1] as number) + 1,
				(prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		prev = row;
	}
	return prev[b.length] as number;
}

/** Up to three label names close to `name`, closest first. */
function closeNames(labels: readonly ApiLabel[], name: string): string[] {
	const want = name.toLowerCase();
	const scope = want.split("/")[0] ?? want;
	return labels
		.map((l) => ({ name: l.name, lower: l.name.toLowerCase() }))
		.map((l) => ({
			name: l.name,
			score:
				l.lower.includes(want) || want.includes(l.lower)
					? 0
					: l.lower.startsWith(`${scope}/`)
						? 1
						: distance(l.lower, want),
		}))
		.filter((l) => l.score <= 2)
		.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
		.slice(0, 3)
		.map((l) => l.name);
}

/**
 * Finds the labels that the given names mean. An exact name wins; otherwise a
 * name matches without case when exactly one label matches. The server ignores
 * an unknown name with no error, so fgj refuses it before any request that uses it.
 *
 * @param labels - Every label of the repository, from {@link repoLabels}.
 * @param names - The names the caller wrote.
 * @param hint - The help command for an ambiguous name. An unknown or
 *   archived name hints the label list instead.
 * @param options - `archived: true` lets an archived label match, for a filter.
 *   `listHint` is the label list command for the error, with the call's `--repo`.
 * @returns The labels, in the order of `names`.
 * @throws {FgjError} A usage error for an unknown, ambiguous, or archived name.
 * @example
 * resolveLabels(labels, ["Priority/P1"], "fgj help issue list"); // [{ name: "priority/p1", … }]
 */
export function resolveLabels(
	labels: readonly ApiLabel[],
	names: readonly string[],
	hint: string,
	options: { archived?: boolean; listHint?: string } = {},
): ApiLabel[] {
	const listHint = options.listHint ?? "fgj read label list";
	// An archived label cannot be added, so it must not make a live name ambiguous.
	const eligible = options.archived
		? labels
		: labels.filter((l) => !l.is_archived);
	return names.map((name) => {
		const exact = labels.find((l) => l.name === name);
		const loose = eligible.filter(
			(l) => l.name.toLowerCase() === name.toLowerCase(),
		);
		if (!exact && loose.length > 1) {
			throw new FgjError(
				"usage",
				`The label "${name}" matches ${loose.map((l) => l.name).join(" and ")} without case. Write the exact name.`,
				hint,
			);
		}
		const found =
			exact ??
			loose[0] ??
			labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
		if (!found) {
			const close = closeNames(eligible, name);
			throw new FgjError(
				"usage",
				`Unknown label "${name}".${close.length ? ` Did you mean: ${close.join(", ")}?` : ""} fgj reads only this repository's labels, not organization labels.`,
				listHint,
			);
		}
		if (found.is_archived && !options.archived) {
			throw new FgjError(
				"usage",
				`The label "${found.name}" is archived. Use a live label.`,
				listHint,
			);
		}
		return found;
	});
}

const LIST_FIELDS = {
	all: ["name", "exclusive", "description", "color"],
	default: ["name", "exclusive"],
} as const;

interface ListInput {
	fields: readonly string[];
	offset: number;
}

/** `fgj read label list`: every live label of the repository, by name. */
export const labelList: ReadVerb<ListInput> = {
	risk: "read",
	noun: "label",
	action: "list",
	summary: "List the repository's labels by name, and which are exclusive.",
	notes: [
		"It returns every live label in one call. Archived labels are left out.",
		"exclusive:true marks a scoped label, such as priority/p1: an issue holds one label of its scope, and adding another replaces it.",
	],
	args: [],
	flags: [
		{
			name: "fields",
			kind: "fields",
			value: "a,b",
			description: "Comma list of fields. Alone, it lists the fields.",
		},
		{
			name: "offset",
			kind: "int",
			description: "Index of the first label. `next` sets it for you.",
		},
		REPO_FLAG,
	],
	fields: LIST_FIELDS,
	output:
		"{items:[{name, exclusive}]}. exclusive only when true. color is six lowercase hex digits with no #. next only when the result passes the output cap.",
	examples: [
		"fgj read label list",
		"fgj read label list --fields name,color,description,exclusive",
	],
	prepare(args: ParsedArgs): ListInput {
		const hint = "fgj help label list";
		return {
			fields: selectFields(args.flags.fields, LIST_FIELDS, hint),
			offset: rangeFlag(args, "offset", 0, Number.MAX_SAFE_INTEGER, 0, hint),
		};
	},
	async run(input, { target, api, commandWith }) {
		const items = (await repoLabels(api, target))
			.filter((l) => !l.is_archived)
			.map((l) =>
				pick(
					{
						name: l.name,
						exclusive: l.exclusive ? true : undefined,
						description: l.description || undefined,
						color: l.color.toLowerCase(),
					},
					input.fields,
				),
			);
		const shown = page(items, input.offset, items.length, (end) =>
			commandWith({ offset: end }),
		);
		return shown.next
			? { items: shown.items, next: shown.next }
			: { items: shown.items };
	},
};

interface CreateInput {
	name: string;
	color: string;
	description: string;
	exclusive: boolean;
	dryRun: boolean;
}

/** Reads `--name`: trimmed, not empty, and one line. */
function nameFlag(args: ParsedArgs, hint: string): string {
	const raw = args.flags.name;
	const name = raw === undefined ? "" : String(raw).trim();
	if (name === "" || /[\r\n]/.test(name)) {
		throw new FgjError("usage", "--name needs a name on one line.", hint);
	}
	if (name.includes(",")) {
		throw new FgjError(
			"usage",
			`--name cannot hold a comma: issue edit --add-label splits names at commas, so it could not assign "${name}".`,
			hint,
		);
	}
	return name;
}

/** Reads `--color`: exactly six hex digits, stored lowercase. */
function colorFlag(args: ParsedArgs, hint: string): string {
	const raw = args.flags.color;
	if (raw === undefined)
		throw new FgjError("usage", "Missing --color RRGGBB.", hint);
	const color = String(raw).trim();
	if (color.startsWith("#")) {
		throw new FgjError(
			"usage",
			`Write the color without #: --color ${color.slice(1) || "5319e7"}. An unquoted # starts a shell comment.`,
			hint,
		);
	}
	if (!/^[0-9a-f]{6}$/i.test(color)) {
		throw new FgjError(
			"usage",
			`--color needs six hex digits, such as 5319e7, got "${color}".`,
			hint,
		);
	}
	return color.toLowerCase();
}

/** Reads `--description`: trimmed and one line, or `undefined` when absent. */
function descriptionFlag(args: ParsedArgs, hint: string): string | undefined {
	const raw = args.flags.description;
	if (raw === undefined) return undefined;
	const description = String(raw).trim();
	if (/[\r\n]/.test(description)) {
		throw new FgjError("usage", "--description needs one line.", hint);
	}
	return description;
}

/** Refuses `--exclusive` for a name with no scope, such as `plain` or `priority/`. */
function needScope(name: string, hint: string): void {
	// The scope ends at the last slash, as in Forgejo and issue edit.
	const slash = name.lastIndexOf("/");
	if (slash <= 0 || slash === name.length - 1) {
		throw new FgjError(
			"usage",
			`--exclusive needs a scoped name, such as priority/high; "${name}" has no scope.`,
			hint,
		);
	}
}

/**
 * `fgj write label create --name NAME --color RRGGBB`: adds one label to the
 * repository. Forgejo does not check that names are unique, so fgj reads every
 * label first: the same label returns changed:false, and a label with the same
 * name but other values is a conflict that fgj does not overwrite.
 */
export const labelCreate: WriteVerb<CreateInput> = {
	risk: "write",
	noun: "label",
	action: "create",
	summary:
		"Add a label to the repository. The same label again returns changed:false.",
	notes: [
		"Names match without case. A label with the name and another color, description, or exclusivity fails with conflict; fgj never edits it.",
		"Two labels that share the name, an archived one, or one with spaces around its name also fail with conflict: fgj does not pick, revive, or copy one.",
		"--exclusive needs a scoped name, such as priority/high: an issue then holds one label of that scope, and issue edit swaps it.",
		"Forgejo does not check that names are unique. fgj reads every label first, but two calls at the same time can still make two labels.",
		"The result is {changed, name}; name is the stored spelling.",
	],
	args: [],
	flags: [
		{
			name: "name",
			kind: "string",
			value: "NAME",
			description: "The label name, such as type/epic. No comma.",
			required: true,
		},
		{
			name: "color",
			kind: "string",
			value: "RRGGBB",
			description: "Six hex digits with no #, such as 5319e7.",
			required: true,
		},
		{
			name: "description",
			kind: "string",
			value: "TEXT",
			description: "One line. Quote it. Default: empty.",
		},
		{
			name: "exclusive",
			kind: "bool",
			description:
				"One label per issue in this scope. Needs a scoped name, such as priority/high.",
		},
		DRY_RUN_FLAG,
		REPO_FLAG,
	],
	output:
		"{changed, name}. changed:false means the label already existed with these values. --dry-run: {dry_run, changed, name, apply}.",
	examples: [
		"fgj write label create --name type/epic --color 5319e7 --description 'A plan of several slices'",
		"fgj write label create --name priority/high --color b60205 --exclusive --dry-run",
	],
	prepare(args: ParsedArgs): CreateInput {
		const hint = "fgj help label create";
		if (args.positionals.length > 0) {
			throw new FgjError(
				"usage",
				`label create takes no argument, got ${args.positionals.join(" ")}. Give the name with --name.`,
				hint,
			);
		}
		const name = nameFlag(args, hint);
		const color = colorFlag(args, hint);
		const description = descriptionFlag(args, hint) ?? "";
		const exclusive = args.flags.exclusive === true;
		if (exclusive) needScope(name, hint);
		return {
			name,
			color,
			description,
			exclusive,
			dryRun: args.flags["dry-run"] === true,
		};
	},
	async run(input, { target, api, commandWith, commandFor }) {
		const listHint = commandFor("read label list", []);
		const labels = await repoLabels(api, target);
		const quoted = (list: readonly ApiLabel[]) =>
			list.map((l) => JSON.stringify(l.name)).join(", ");
		// Names compare as issue edit reads them: without case, not trimmed.
		const same = labels.filter(
			(l) => l.name.toLowerCase() === input.name.toLowerCase(),
		);
		if (same.length > 1) {
			throw new FgjError(
				"conflict",
				`The name "${input.name}" matches ${same.length} labels (${quoted(same)}). fgj does not pick one.`,
				listHint,
			);
		}
		// Another client can store spaces around a name. issue edit cannot
		// assign such a label by name, so fgj neither matches nor copies it.
		const spaced = same.length
			? []
			: labels.filter(
					(l) => l.name.trim().toLowerCase() === input.name.toLowerCase(),
				);
		if (spaced.length > 0) {
			throw new FgjError(
				"conflict",
				`The label ${quoted(spaced)} exists with spaces around its name, and issue edit cannot assign it by name. fgj does not change an existing label or add a near-duplicate.`,
				listHint,
			);
		}
		const found = same[0];
		if (found?.is_archived) {
			throw new FgjError(
				"conflict",
				`The label "${found.name}" exists and is archived. fgj does not revive it.`,
				listHint,
			);
		}
		if (found) {
			const differ = [
				found.color.toLowerCase() !== input.color ? `color ${found.color}` : "",
				(found.description ?? "") !== input.description
					? `description "${found.description ?? ""}"`
					: "",
				found.exclusive !== input.exclusive
					? `exclusive ${found.exclusive}`
					: "",
			].filter(Boolean);
			if (differ.length > 0) {
				throw new FgjError(
					"conflict",
					`The label "${found.name}" exists with ${differ.join(", ")}. fgj does not change an existing label.`,
					listHint,
				);
			}
		}
		const send = {
			name: input.name,
			color: input.color,
			description: input.description,
			exclusive: input.exclusive,
		};
		if (input.dryRun) {
			if (!found) api.assertSendable(send);
			return {
				dry_run: true,
				changed: !found,
				name: found?.name ?? input.name,
				apply: commandWith({ "dry-run": undefined }),
			};
		}
		if (found) return { changed: false, name: found.name };
		const created = await api.send<ApiLabel>(
			"POST",
			`/repos/${target.owner}/${target.name}/labels`,
			send,
		);
		return { changed: true, name: created.name };
	},
};

/** The input of `label edit` after the local checks. An undefined field stays as it is. */
export interface LabelEditInput {
	/** The label name as the caller wrote it. */
	label: string;
	/** Six lowercase hex digits. */
	color: string | undefined;
	/** One line; empty clears it. */
	description: string | undefined;
	exclusive: boolean | undefined;
	dryRun: boolean;
}

/** Reads the one label name, which must not have spaces around it. */
function labelArg(args: ParsedArgs, hint: string): string {
	const [name = "", ...more] = args.positionals;
	if (more.length > 0) {
		throw new FgjError(
			"usage",
			`Expected one label, got ${args.positionals.length}: ${args.positionals.join(" ")}. Quote a name with spaces.`,
			hint,
		);
	}
	if (name.trim() === "") {
		throw new FgjError(
			"usage",
			"Missing the label: its name, such as priority/p1.",
			hint,
		);
	}
	if (name !== name.trim()) {
		throw new FgjError(
			"usage",
			`The label name "${name}" has spaces around it. Write the name without them.`,
			hint,
		);
	}
	return name;
}

/**
 * Finds the one live label to edit: the exact name, else the one name that
 * matches without case. Archived labels never match, so they cannot hide or
 * block a live label. It refuses what issue edit could not assign by name: two
 * live labels with the exact name, or a stored name with spaces around it.
 */
function editTarget(
	labels: readonly ApiLabel[],
	name: string,
	hint: string,
	listHint: string,
): ApiLabel {
	const live = labels.filter((l) => !l.is_archived);
	const exact = live.filter((l) => l.name === name);
	if (exact.length > 1) {
		throw new FgjError(
			"conflict",
			`The name "${name}" matches ${exact.length} live labels. fgj does not pick one.`,
			listHint,
		);
	}
	if (exact[0]) return exact[0];
	const lower = name.toLowerCase();
	if (!live.some((l) => l.name.toLowerCase() === lower)) {
		const archived = labels.find(
			(l) => l.is_archived && l.name.toLowerCase() === lower,
		);
		if (archived) {
			throw new FgjError(
				"usage",
				`The label "${archived.name}" is archived. fgj does not edit or revive it.`,
				listHint,
			);
		}
		const spaced = live.filter((l) => l.name.trim().toLowerCase() === lower);
		if (spaced.length > 0) {
			throw new FgjError(
				"conflict",
				`The label ${spaced.map((l) => JSON.stringify(l.name)).join(", ")} has spaces around its name, and issue edit cannot assign it by name. fgj does not edit it.`,
				listHint,
			);
		}
	}
	// Only live labels remain: an ambiguous or unknown name fails here.
	return resolveLabels(live, [name], hint, { listHint })[0] as ApiLabel;
}

/**
 * `fgj write label edit <label>`: changes the color, description, or
 * exclusivity of one label. It sends only the fields that differ, so a repeat
 * sends nothing. The label keeps its id and name, and its issues keep it.
 */
export const labelEdit: WriteVerb<LabelEditInput> = {
	risk: "write",
	noun: "label",
	action: "edit",
	summary:
		"Change a label's color, description, or exclusivity. What is already so returns changed:false.",
	notes: [
		"A label is its exact live name, else its name without case when one live label matches. Archived labels never match. Two live labels with the exact name, a name that only an archived label has, or a name stored with spaces around it fail: fgj does not pick or revive one.",
		"Only the given fields change. The label keeps its name, and its issues keep it. --description none, in any case, clears the description.",
		"--exclusive needs a scoped name, such as priority/high. It moves no labels: an issue keeps every label of the scope that it holds. A later add of an exclusive label of the scope removes the other exclusive labels of that scope; labels that are not exclusive stay.",
		"The result is {changed, name}; name is the stored spelling.",
	],
	args: [
		{
			name: "label",
			description:
				"The label name, such as priority/p1. Quote a name with spaces.",
		},
	],
	flags: [
		{
			name: "color",
			kind: "string",
			value: "RRGGBB",
			description: "Six hex digits with no #, such as 5319e7.",
		},
		{
			name: "description",
			kind: "string",
			value: "TEXT",
			description: "One line. Quote it. none, in any case, clears it.",
		},
		{
			name: "exclusive",
			kind: "bool",
			description:
				"One label per issue in this scope. Needs a scoped name, such as priority/high.",
		},
		{
			name: "no-exclusive",
			kind: "bool",
			description: "Let an issue hold several labels of this scope.",
		},
		DRY_RUN_FLAG,
		REPO_FLAG,
	],
	output:
		"{changed, name}. changed:false means the label already has these values, and fgj sent nothing. --dry-run: {dry_run, changed, name, apply}.",
	examples: [
		"fgj write label edit priority/p1 --color d93f0b --description 'Next approved work'",
		"fgj write label edit priority/p1 --no-exclusive --dry-run",
	],
	prepare(args: ParsedArgs): LabelEditInput {
		const hint = "fgj help label edit";
		const label = labelArg(args, hint);
		const color =
			args.flags.color === undefined ? undefined : colorFlag(args, hint);
		const raw = descriptionFlag(args, hint);
		// Only the word none clears, so a blank value cannot clear by mistake.
		if (raw === "") {
			throw new FgjError(
				"usage",
				"--description needs text. To clear the description, write --description none.",
				hint,
			);
		}
		const description = raw?.toLowerCase() === "none" ? "" : raw;
		const on = args.flags.exclusive === true;
		const off = args.flags["no-exclusive"] === true;
		if (on && off) {
			throw new FgjError(
				"usage",
				"Give --exclusive or --no-exclusive, not both.",
				hint,
			);
		}
		if (on) needScope(label, hint);
		const exclusive = on ? true : off ? false : undefined;
		if (
			color === undefined &&
			description === undefined &&
			exclusive === undefined
		) {
			throw new FgjError(
				"usage",
				"Nothing to change. Give --color, --description, --exclusive, or --no-exclusive.",
				hint,
			);
		}
		return {
			label,
			color,
			description,
			exclusive,
			dryRun: args.flags["dry-run"] === true,
		};
	},
	async run(input, { target, api, commandWith, commandFor }) {
		const listHint = commandFor("read label list", []);
		const labels = await repoLabels(api, target);
		const label = editTarget(
			labels,
			input.label,
			"fgj help label edit",
			listHint,
		);
		const patch = {
			...(input.color !== undefined && input.color !== label.color.toLowerCase()
				? { color: input.color }
				: {}),
			...(input.description !== undefined &&
			input.description !== (label.description ?? "")
				? { description: input.description }
				: {}),
			...(input.exclusive !== undefined && input.exclusive !== label.exclusive
				? { exclusive: input.exclusive }
				: {}),
		};
		const changed = Object.keys(patch).length > 0;
		if (input.dryRun) {
			if (changed) api.assertSendable(patch);
			return {
				dry_run: true,
				changed,
				name: label.name,
				apply: commandWith({ "dry-run": undefined }),
			};
		}
		if (changed) {
			await api.send(
				"PATCH",
				`/repos/${target.owner}/${target.name}/labels/${label.id}`,
				patch,
			);
		}
		return { changed, name: label.name };
	},
};

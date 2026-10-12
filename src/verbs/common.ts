import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { FgjError } from "../core/errors.ts";
import { BODY_MAX_LIMIT, page } from "../core/output.ts";
import type {
	FlagSpec,
	FlagValue,
	LocalEnv,
	ParsedArgs,
	VerbContext,
} from "../core/verb.ts";
import type { ReadApi } from "../forgejo/client.ts";
import { parseRemote, type Remote, type Target } from "../forgejo/target.ts";

/** The trailing `--repo owner/name` flag that every repository verb accepts. */
export const REPO_FLAG: FlagSpec = {
	name: "repo",
	kind: "string",
	value: "owner/name",
	description: "The repository, instead of the one from git origin.",
};

/** The `--body-file PATH` flag. fgj takes every body from a file. */
export const BODY_FILE_FLAG: FlagSpec = {
	name: "body-file",
	kind: "string",
	value: "PATH",
	required: true,
	description:
		"Path to the body text, in UTF-8 Markdown. fgj sends it byte for byte: line endings and a final newline count. A quoted ~/ means the home directory.",
};

/** The optional `--body-file PATH` flag, for a verb that has a body but does not need one. */
export const OPTIONAL_BODY_FILE_FLAG: FlagSpec = {
	...BODY_FILE_FLAG,
	required: false,
};

/** The `--dry-run` flag: show the plan and the exact apply command, and write nothing. */
export const DRY_RUN_FLAG: FlagSpec = {
	name: "dry-run",
	kind: "bool",
	description: "Show the plan and the exact apply command. Write nothing.",
};

/** The largest body or text file fgj reads. */
export const BODY_FILE_MAX_BYTES = 1024 * 1024;

/**
 * Reads the `--body-file` flag locally: it expands a leading `~/`, resolves a
 * relative path against the working directory, and checks size and content.
 *
 * @param flag - The raw `--body-file` value, or undefined when it is missing.
 * @param local - The working directory and home directory.
 * @param hint - The help command for the error.
 * @returns The file's text, exactly as written, never blank.
 * @throws {FgjError} A usage error for a missing flag, an unreadable, binary,
 *   empty, or too large file.
 * @example
 * readBodyFile("c.md", { cwd: "/tmp", home: "/Users/a" }, "fgj help comment add");
 */
export function readBodyFile(
	flag: FlagValue | undefined,
	local: LocalEnv,
	hint: string,
): string {
	return readTextFile(flag, local, hint, {
		kind: "body file",
		missing: "Missing --body-file PATH. Write the body to a file first.",
	}).text;
}

/** A local text file that fgj read: its path, its text, and its size in bytes. */
export interface TextFile {
	path: string;
	text: string;
	size: number;
}

/**
 * Reads a text file flag with the body-file rules: a leading `~/` is the home
 * directory, a relative path starts at the working directory, and the file is
 * UTF-8 text, not binary, and at most 1 MiB. Empty text needs explicit permission.
 *
 * @param flag - The raw flag value, or undefined when it is missing.
 * @param local - The working directory and home directory.
 * @param hint - The help command for the error.
 * @param words - `kind` names the file in errors; `missing` is the error for a missing flag; `allowEmpty` permits empty text.
 * @returns The resolved path, the text exactly as written, and its size in bytes.
 * @throws {FgjError} A usage error for a missing flag, an unreadable, binary,
 *   disallowed empty, or too large file.
 * @example
 * readTextFile("e.md", { cwd: "/tmp", home: "/Users/a" }, "fgj help comment attach", { kind: "file", missing: "Missing --file PATH." });
 */
export function readTextFile(
	flag: FlagValue | undefined,
	local: LocalEnv,
	hint: string,
	words: { kind: string; missing: string; allowEmpty?: boolean },
): TextFile {
	const kind = words.kind;
	if (typeof flag !== "string") {
		throw new FgjError("usage", words.missing, hint);
	}
	const expanded =
		flag.startsWith("~/") && local.home
			? `${local.home}${flag.slice(1)}`
			: flag;
	const path = resolve(local.cwd, expanded);
	let text: string;
	let size = 0;
	try {
		const stat = statSync(path);
		size = stat.size;
		if (!stat.isFile()) throw new Error("not a file");
		if (stat.size > BODY_FILE_MAX_BYTES) {
			throw new FgjError(
				"usage",
				`The ${kind} ${flag} has ${stat.size} bytes; the limit is ${BODY_FILE_MAX_BYTES}.`,
				hint,
			);
		}
		// A strict decode: a byte that is not UTF-8 would otherwise become U+FFFD
		// and change the body with no error. ignoreBOM keeps a BOM in the text.
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			readFileSync(path),
		);
	} catch (err) {
		if (err instanceof FgjError) throw err;
		if (err instanceof TypeError) {
			throw new FgjError(
				"usage",
				`The ${kind} ${flag} is not UTF-8. Save it as UTF-8.`,
				hint,
			);
		}
		throw new FgjError("usage", `Cannot read the ${kind} ${flag}.`, hint);
	}
	if (text.includes("\0")) {
		throw new FgjError(
			"usage",
			`The ${kind} ${flag} is binary. Use a text file.`,
			hint,
		);
	}
	// Forgejo stores a body byte for byte, so fgj sends the file as written:
	// line endings and trailing whitespace are the author's.
	if (!text.trim() && !words.allowEmpty) {
		throw new FgjError("usage", `The ${kind} ${flag} is empty.`, hint);
	}
	return { path, text, size };
}

/**
 * Names the author of an issue or comment. One migrated from another forge
 * keeps its original author's name; a deleted user shows as Forgejo's `Ghost`.
 *
 * @param c - The item's `original_author` and `user` fields.
 * @returns The author's name, or `null` when the API gives none.
 * @example
 * authorName({ original_author: "", user: { login: "bob" } }); // "bob"
 */
export function authorName(c: {
	original_author: string;
	user: { login: string } | null;
}): string | null {
	return c.original_author || c.user?.login || null;
}

/** The longest title that Forgejo stores for an issue or a pull request. */
export const TITLE_MAX = 255;

/**
 * Reads `--title`, trimmed.
 *
 * @param args - The parsed arguments.
 * @param hint - The help command for the error.
 * @param required - True when the verb cannot run without a title.
 * @returns The title, or `undefined` when the flag is absent and not required.
 * @throws {FgjError} A usage error for a missing required title, or a title
 *   that is blank or longer than {@link TITLE_MAX} characters.
 * @example
 * titleFlag({ positionals: [], flags: { title: " Fix login " } }, "fgj help issue create", true); // "Fix login"
 */
export function titleFlag(
	args: ParsedArgs,
	hint: string,
	required: boolean,
): string | undefined {
	const raw = args.flags.title;
	if (raw === undefined) {
		if (required) throw new FgjError("usage", "Missing --title TEXT.", hint);
		return undefined;
	}
	const title = String(raw).trim();
	if (title === "" || Array.from(title).length > TITLE_MAX) {
		throw new FgjError(
			"usage",
			`--title needs 1 to ${TITLE_MAX} characters.`,
			hint,
		);
	}
	return title;
}

/**
 * The API path of a branch. Each part is encoded, and `/` stays, because the
 * client refuses an encoded `/`.
 *
 * @param target - The repository.
 * @param branch - The branch name, for example `feat/login`.
 * @returns The path after `/api/v1`.
 * @example
 * branchPath(target, "feat/login"); // "/repos/o/r/branches/feat/login"
 */
export function branchPath(target: Target, branch: string): string {
	const name = branch.split("/").map(encodeURIComponent).join("/");
	return `/repos/${target.owner}/${target.name}/branches/${name}`;
}

/** An issue reference: the number, and the repository when the argument was a URL. */
export interface IssueRef {
	number: number;
	remote?: Remote;
	/** The argument as `next` and hints repeat it: `157`, or the clean issue URL. */
	canonical: string;
}

/**
 * An issue or pull request URL. Each number in an argument has at most 15
 * digits, so it stays an exact integer in JavaScript and in the request path.
 */
const ISSUE_URL =
	/^(https?:\/\/.+?)\/(issues|pulls)\/([1-9]\d{0,14})(?:[/?#].*)?$/;

/**
 * Reads an issue or pull request reference: `157`, `#157`, or a Forgejo issue
 * or pull request URL. A URL also names the host and the repository.
 *
 * @param args - The parsed arguments. The reference is the only positional.
 * @param hint - The help command for the error.
 * @param noun - What the argument names, for the words of an error.
 * @returns The number and, for a URL, the host and repository.
 * @throws {FgjError} A usage error when there is not exactly one valid reference.
 * @example
 * issueRef({ positionals: ["#157"], flags: {} }, "fgj help comment list");
 * // { number: 157, canonical: "157" }
 */
export function issueRef(
	args: ParsedArgs,
	hint: string,
	noun: RefNoun = "issue",
): IssueRef {
	if (args.positionals.length === 0) {
		throw new FgjError("usage", missing(noun), hint);
	}
	if (args.positionals.length > 1) {
		throw new FgjError(
			"usage",
			`Expected one ${noun} number, got ${args.positionals.length}: ${args.positionals.join(" ")}.`,
			hint,
		);
	}
	return parseIssueArg(args.positionals[0] as string, hint, noun);
}

/** What an argument names, for the words of an error. */
export type RefNoun = "issue" | "pull request";

const article = (noun: RefNoun) => (noun === "issue" ? "an" : "a");

const missing = (noun: RefNoun) =>
	`Missing the ${noun} number. An unquoted # starts a shell comment: write 157, not #157.`;

/**
 * Reads one issue or pull request argument: `157`, `#157`, or a URL. The
 * canonical form keeps the URL's `issues` or `pulls`, so a hint repeats it.
 */
function parseIssueArg(raw: string, hint: string, noun: RefNoun): IssueRef {
	const plain = /^#?([1-9]\d{0,14})$/.exec(raw);
	if (plain) return { number: Number(plain[1]), canonical: plain[1] as string };
	const url = ISSUE_URL.exec(raw);
	const remote = url ? parseRemote(url[1] as string) : null;
	if (url && remote) {
		const n = url[3] as string;
		const canonical = `${remote.baseUrl}/${remote.owner}/${remote.name}/${url[2]}/${n}`;
		return { number: Number(n), remote, canonical };
	}
	throw new FgjError(
		"usage",
		`Expected ${article(noun)} ${noun} number or ${noun} URL, got "${raw}".`,
		hint,
	);
}

/** Several issue references in one repository. */
export interface IssueRefs {
	refs: IssueRef[];
	/** The repository that the URL arguments name, if any. */
	remote?: Remote;
}

/**
 * Reads one or more issue references, as {@link issueRef} reads one. Either
 * every argument is a number, or every argument is a URL of one repository.
 *
 * @param args - The parsed arguments. Every positional is a reference.
 * @param max - The most references in one call.
 * @param hint - The help command for the error.
 * @param noun - What the arguments name, for the words of an error.
 * @returns The references in the order given, and the repository a URL names.
 * @throws {FgjError} A usage error for no reference, too many, a bad one, or
 *   URLs of two repositories.
 * @example
 * issueRefs({ positionals: ["5", "#6"], flags: {} }, 50, "fgj help issue get");
 * // { refs: [{ number: 5, canonical: "5" }, { number: 6, canonical: "6" }] }
 */
export function issueRefs(
	args: ParsedArgs,
	max: number,
	hint: string,
	noun: RefNoun = "issue",
): IssueRefs {
	const count = args.positionals.length;
	if (count === 0) throw new FgjError("usage", missing(noun), hint);
	if (count > max) {
		throw new FgjError(
			"usage",
			`At most ${max} ${noun}s in one call, got ${count}. Split the call.`,
			hint,
		);
	}
	const refs = args.positionals.map((raw) => parseIssueArg(raw, hint, noun));
	const remotes = refs.flatMap((r) => (r.remote ? [r.remote] : []));
	// A plain number next to a URL would silently move to the URL's repository.
	if (remotes.length > 0 && remotes.length < refs.length) {
		throw new FgjError(
			"usage",
			`Give every ${noun} as a number, or every ${noun} as a URL. A number next to a URL is ambiguous: use --repo owner/name with numbers.`,
			hint,
		);
	}
	const key = (r: Remote) => `${r.baseUrl}/${r.owner}/${r.name}`.toLowerCase();
	const first = remotes[0];
	if (first && remotes.some((r) => key(r) !== key(first))) {
		throw new FgjError(
			"usage",
			`The ${noun} URLs name more than one repository. Read each repository in its own call.`,
			hint,
		);
	}
	return first ? { refs, remote: first } : { refs };
}

/** A comment reference: the id, and the repository when the argument was a URL. */
export interface CommentRef {
	id: number;
	/** The issue number that a comment URL names. fgj checks it against the comment. */
	issue?: number;
	remote?: Remote;
	/** The argument as `apply` and hints repeat it: `770`, or the clean comment URL. */
	canonical: string;
}

/**
 * The shape of every argument that {@link commentRef} accepts, as a regex
 * source. The pi gate uses it to name a delete only for an argument that fgj
 * reads; a unit test keeps the two in step.
 */
export const COMMENT_ARG_SHAPE = String.raw`^(?:#?issuecomment-)?[1-9]\d{0,14}$|^https?://\S+?/(?:issues|pulls)/[1-9]\d{0,14}(?:[/?]\S*)?#issuecomment-[1-9]\d{0,14}$`;

const COMMENT_ID = /^#?(?:issuecomment-)([1-9]\d{0,14})$|^([1-9]\d{0,14})$/;

/**
 * Reads a comment reference: `770`, `issuecomment-770`, or a Forgejo comment URL
 * such as `https://host/o/r/issues/4#issuecomment-770`. A URL also names the host
 * and the repository.
 *
 * @param args - The parsed arguments. The reference is the only positional.
 * @param hint - The help command for the error.
 * @returns The id and, for a URL, the host and repository.
 * @throws {FgjError} A usage error when there is not exactly one valid reference.
 * @example
 * commentRef({ positionals: ["770"], flags: {} }, "fgj help comment get");
 * // { id: 770, canonical: "770" }
 */
export function commentRef(args: ParsedArgs, hint: string): CommentRef {
	if (args.positionals.length !== 1) {
		throw new FgjError(
			"usage",
			args.positionals.length === 0
				? "Missing the comment id. fgj read comment list <issue> shows the ids."
				: `Expected one comment id, got ${args.positionals.length}: ${args.positionals.join(" ")}.`,
			hint,
		);
	}
	const raw = args.positionals[0] as string;
	const plain = COMMENT_ID.exec(raw);
	if (plain) {
		const id = (plain[1] ?? plain[2]) as string;
		return { id: Number(id), canonical: id };
	}
	if (/^#[1-9]\d*$/.test(raw)) {
		throw new FgjError(
			"usage",
			`${raw} names an issue. A comment id is the number after #issuecomment- in a comment URL.`,
			hint,
		);
	}
	const url = ISSUE_URL.exec(raw);
	const remote = url ? parseRemote(url[1] as string) : null;
	if (url && remote) {
		const issue = `${remote.baseUrl}/${remote.owner}/${remote.name}/issues/${url[3]}`;
		const fragment = /#issuecomment-([1-9]\d{0,14})$/.exec(raw);
		if (!fragment) {
			throw new FgjError(
				"usage",
				`The URL names issue ${url[3]}, not a comment. Use a comment URL (#issuecomment-ID) or an id from comment list.`,
				`fgj read comment list ${issue}`,
			);
		}
		const id = fragment[1] as string;
		return {
			id: Number(id),
			issue: Number(url[3]),
			remote,
			canonical: `${issue}#issuecomment-${id}`,
		};
	}
	throw new FgjError(
		"usage",
		`Expected a comment id or comment URL, got "${raw}".`,
		hint,
	);
}

/**
 * Reads a whole-number flag and checks its range.
 *
 * @param args - The parsed arguments.
 * @param name - The flag name without `--`.
 * @param min - The smallest allowed value.
 * @param max - The largest allowed value.
 * @param fallback - The value when the flag is absent.
 * @param hint - The help command for the error.
 * @returns The value, from `min` to `max`.
 * @throws {FgjError} A usage error when the value is out of range.
 * @example
 * rangeFlag(args, "limit", 1, 100, 20, "fgj help comment list"); // 20
 */
export function rangeFlag(
	args: ParsedArgs,
	name: string,
	min: number,
	max: number,
	fallback: number,
	hint: string,
): number {
	const value = args.flags[name];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || value < min || value > max) {
		throw new FgjError(
			"usage",
			`--${name} must be from ${min} to ${max}, got ${String(value)}.`,
			hint,
		);
	}
	return value;
}

/** The most requests that one call runs at the same time. */
const READ_PARALLEL = 8;

/**
 * Runs `fn` on every item, at most `limit` at a time, and keeps the order.
 *
 * @param items - The inputs.
 * @param limit - The most calls in flight.
 * @param fn - The async work for one item.
 * @returns The results, in the order of `items`.
 * @example
 * await mapLimit([1, 2, 3], 2, async (n) => n * 2); // [2, 4, 6]
 */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return out;
}

/**
 * Fails with not_found for the repository when it does not exist, so a wrong
 * repository never reads as a list of missing issues.
 *
 * @param api - A client with the read or write token.
 * @param target - The repository to check.
 * @param hint - The help command for the error.
 * @returns Nothing when the repository exists.
 * @throws {FgjError} not_found when the token cannot see the repository.
 * @example
 * await assertRepo(ctx.api, ctx.target, "fgj help board list");
 */
export async function assertRepo(
	api: Pick<ReadApi, "get">,
	target: Target,
	hint: string,
): Promise<void> {
	try {
		await api.get(`/repos/${target.owner}/${target.name}`);
	} catch (err) {
		if (err instanceof FgjError && err.code === "not_found") {
			throw new FgjError(
				"not_found",
				`The repository ${target.owner}/${target.name} does not exist, or the token cannot see it.`,
				hint,
			);
		}
		throw err;
	}
}

/**
 * The shared run of the verbs that read one or many items by number, such as
 * `issue get` and `pr get`. One number returns the item itself; more return
 * `{items, missing}`, and `next` when the output cap cuts the result. When
 * every item is missing, it checks the repository, so a wrong repository never
 * reads as a list of missing numbers.
 *
 * @param input - The references, whether one was given, and `--body-max`.
 * @param ctx - The verb context.
 * @param readOne - Reads one item as output, or `null` when it does not exist.
 * @param missingOne - Builds the error for one missing number. It may throw a
 *   more exact error itself, such as "an issue, not a pull request".
 * @param helpHint - The verb's help command, for a missing repository.
 * @returns The item, or `{items, missing, next, hint}`.
 * @throws {FgjError} The error from `missingOne` for one missing number, or
 *   not_found for a missing repository.
 * @example
 * return readMany(input, ctx, (n) => readIssue(input, ctx, n), missing, "fgj help issue get");
 */
export async function readMany(
	input: { refs: IssueRef[]; single: boolean; bodyMax: number },
	ctx: VerbContext<ReadApi>,
	readOne: (n: number) => Promise<Record<string, unknown> | null>,
	missingOne: (ref: IssueRef) => Promise<FgjError>,
	helpHint: string,
): Promise<Record<string, unknown>> {
	const unique = [...new Map(input.refs.map((r) => [r.number, r])).values()];
	const read = await mapLimit(unique, READ_PARALLEL, (r) => readOne(r.number));
	if (!input.single && read.every((i) => i === null)) {
		await assertRepo(ctx.api, ctx.target, helpHint);
	}
	const bodyHint = (ref: IssueRef) =>
		input.bodyMax < BODY_MAX_LIMIT
			? ctx.commandWith({ "body-max": BODY_MAX_LIMIT }, [ref.canonical])
			: undefined;
	if (input.single) {
		const ref = unique[0] as IssueRef;
		const item = read[0];
		if (!item) {
			// missingOne may name what the number is instead; only then the repository.
			const error = await missingOne(ref);
			await assertRepo(ctx.api, ctx.target, helpHint);
			throw error;
		}
		const hint = item.body_truncated ? bodyHint(ref) : undefined;
		return hint ? { ...item, hint } : item;
	}
	const found = unique.flatMap((ref, i) => {
		const item = read[i];
		return item ? [{ ref, item }] : [];
	});
	const missing = unique.filter((_, i) => !read[i]).map((r) => r.number);
	const shown = page(
		found.map((f) => f.item),
		0,
		found.length,
		(end) =>
			ctx.commandWith(
				{},
				found.slice(end).map((f) => f.ref.canonical),
			),
	);
	const cut = found.find(
		(f, i) => i < shown.items.length && f.item.body_truncated,
	);
	const hint = cut ? bodyHint(cut.ref) : undefined;
	return {
		items: shown.items,
		...(missing.length > 0 ? { missing } : {}),
		...(shown.next ? { next: shown.next } : {}),
		...(hint ? { hint } : {}),
	};
}

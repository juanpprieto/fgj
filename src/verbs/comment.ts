import { basename, extname } from "node:path";
import { FgjError } from "../core/errors.ts";
import {
	BODY_MAX_DEFAULT,
	BODY_MAX_LIMIT,
	fitItem,
	ITEM_BUDGET,
	LIST_LIMIT_DEFAULT,
	LIST_LIMIT_MAX,
	page,
	pick,
	selectFields,
	truncateBody,
} from "../core/output.ts";
import type {
	FlagSpec,
	LocalEnv,
	ParsedArgs,
	ReadVerb,
	WriteVerb,
} from "../core/verb.ts";
import type { ReadApi, WriteApi } from "../forgejo/client.ts";
import type { Target } from "../forgejo/target.ts";
import {
	authorName,
	BODY_FILE_FLAG,
	BODY_FILE_MAX_BYTES,
	COMMENT_ARG_SHAPE,
	type CommentRef,
	commentRef,
	DRY_RUN_FLAG,
	type IssueRef,
	issueRef,
	REPO_FLAG,
	rangeFlag,
	readBodyFile,
	readTextFile,
	type TextFile,
} from "./common.ts";

/** A Forgejo issue comment, reduced to the keys fgj reads. */
interface ApiComment {
	id: number;
	body: string | null;
	user: { login: string } | null;
	original_author: string;
	created_at: string;
	updated_at: string;
	html_url: string;
	/** The issue's API URL. It ends in the issue number, for a PR comment too. */
	issue_url: string;
	/** The comment's attachments. */
	assets?: {
		name: string;
		size: number;
		uuid: string;
		browser_download_url: string;
	}[];
}

/** A comment's attachments as fgj shows them, or undefined when it has none. */
function attachmentsOf(
	c: ApiComment,
): { name: string; size: number }[] | undefined {
	const assets = c.assets ?? [];
	// No URL: it needs a browser session, so an agent cannot open it.
	return assets.length === 0
		? undefined
		: assets.map((a) => ({ name: a.name, size: a.size }));
}

/** The most characters of one attachment's text that comment get shows. */
const ATTACHMENT_TEXT_MAX = 8000;

/** One attachment as fgj read it: a `text` only for a text content type. */
export interface AttachmentFile {
	name: string;
	size: number;
	content_type: string;
	text?: string;
}

/** Each attachment's content type, and its text for a text type, read by fgj with the read token. */
async function readAttachments(
	api: ReadApi,
	c: ApiComment,
): Promise<AttachmentFile[]> {
	const out: AttachmentFile[] = [];
	for (const a of c.assets ?? []) {
		out.push({
			name: a.name,
			size: a.size,
			...(await api.attachmentText(a.uuid)),
		});
	}
	return out;
}

/**
 * Cuts the attachment texts so that the item with its attachments fits in
 * `budget`. Each text gets at most {@link ATTACHMENT_TEXT_MAX} characters, and
 * the attachments share what the item leaves, so the body is never cut for them.
 *
 * @param item - The output item, its body already fitted, with no attachments.
 * @param files - The attachments, from the server.
 * @param budget - The most JSON characters the item may take.
 * @returns The attachments to show. A cut text adds `text_truncated` and `text_chars`.
 * @example
 * fitAttachmentTexts({ id: 1 }, [{ name: "a.md", size: 3, content_type: "text/markdown", text: "Hi\n" }]);
 * // [{ name: "a.md", size: 3, content_type: "text/markdown", text: "Hi\n" }]
 */
export function fitAttachmentTexts(
	item: Record<string, unknown>,
	files: readonly AttachmentFile[],
	budget: number = ITEM_BUDGET,
): Record<string, unknown>[] {
	const chars = files.map((f) =>
		f.text === undefined ? undefined : Array.from(f.text),
	);
	const shown = (n: number) =>
		files.map((f, i) => {
			const all = chars[i];
			if (all === undefined || all.length <= n) return { ...f };
			return {
				...f,
				text: all.slice(0, n).join(""),
				text_truncated: true,
				text_chars: all.length,
			};
		});
	const fits = (n: number) =>
		JSON.stringify({ ...item, attachments: shown(n) }).length <= budget;
	let low = 0;
	let high = ATTACHMENT_TEXT_MAX;
	if (fits(high)) return shown(high);
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(mid)) low = mid;
		else high = mid - 1;
	}
	return shown(low);
}

/** The issue number at the end of a comment's `issue_url`. */
function issueOf(c: ApiComment): number {
	return Number(/(\d+)$/.exec(c.issue_url)?.[1]);
}

const COMMENT_FIELDS = {
	all: [
		"id",
		"author",
		"created_at",
		"updated_at",
		"url",
		"body",
		"attachments",
	],
	default: ["id", "author", "created_at", "body"],
} as const;

const LIST_FLAGS: readonly FlagSpec[] = [
	{
		name: "limit",
		kind: "int",
		description: `Most comments per page (1-${LIST_LIMIT_MAX}, default ${LIST_LIMIT_DEFAULT}).`,
	},
	{
		name: "offset",
		kind: "int",
		description: "Index of the first comment. `next` sets it for you.",
	},
	{
		name: "last",
		kind: "int",
		description: `The latest N comments, oldest first (1-${LIST_LIMIT_MAX}). Use it without --limit and --offset.`,
	},
	{
		name: "fields",
		kind: "fields",
		value: "a,b",
		description: "Comma list of fields. Alone, it lists the fields.",
	},
	{
		name: "body-max",
		kind: "int",
		description: `Most body characters per comment (1-${BODY_MAX_LIMIT}, default ${BODY_MAX_DEFAULT}).`,
	},
	{
		name: "author",
		kind: "string",
		value: "NAME",
		description:
			"Only comments by this user, case-insensitive. total and next count only the matches.",
	},
	{
		name: "contains",
		kind: "string",
		value: "TEXT",
		description:
			"Only comments whose body holds this text, case-insensitive. total and next count only the matches.",
	},
	REPO_FLAG,
];

interface ListInput {
	ref: IssueRef;
	limit: number;
	offset: number;
	last: number | undefined;
	fields: readonly string[];
	bodyMax: number;
	/** Lowercase author name to keep, if any. */
	author: string | undefined;
	/** Lowercase body text to keep, if any. */
	contains: string | undefined;
}

/** Reads an optional text filter flag, lowercase. An empty value is a usage error. */
function filterFlag(
	args: ParsedArgs,
	name: string,
	hint: string,
): string | undefined {
	const value = args.flags[name];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new FgjError("usage", `--${name} needs a non-empty value.`, hint);
	}
	return value.toLowerCase();
}

/** `fgj read comment list <issue>`: one page of the comments on an issue, oldest first. */
export const commentList: ReadVerb<ListInput> = {
	risk: "read",
	noun: "comment",
	action: "list",
	summary: "List the comments on an issue or pull request, oldest first.",
	args: [
		{
			name: "issue",
			description: "Issue or pull request number, or its URL.",
		},
	],
	flags: LIST_FLAGS,
	fields: COMMENT_FIELDS,
	output:
		"{items:[{id,author,created_at,body}], total, next}. next is the exact command for the next page, or null. A cut body adds body_truncated, body_chars, and a top-level hint.",
	examples: [
		"fgj read comment list 157",
		"fgj read comment list 157 --author alice --last 5 --fields id,body",
	],
	prepare(args: ParsedArgs): ListInput {
		const hint = "fgj help comment list";
		const flags = args.flags;
		if (
			flags.last !== undefined &&
			(flags.limit !== undefined || flags.offset !== undefined)
		) {
			throw new FgjError(
				"usage",
				"Use --last alone, or --limit with --offset, not both.",
				hint,
			);
		}
		const max = LIST_LIMIT_MAX;
		return {
			ref: issueRef(args, hint),
			limit: rangeFlag(args, "limit", 1, max, LIST_LIMIT_DEFAULT, hint),
			offset: rangeFlag(args, "offset", 0, Number.MAX_SAFE_INTEGER, 0, hint),
			last:
				flags.last === undefined
					? undefined
					: rangeFlag(args, "last", 1, max, max, hint),
			fields: selectFields(flags.fields, COMMENT_FIELDS, hint),
			bodyMax: rangeFlag(
				args,
				"body-max",
				1,
				BODY_MAX_LIMIT,
				BODY_MAX_DEFAULT,
				hint,
			),
			author: filterFlag(args, "author", hint),
			contains: filterFlag(args, "contains", hint),
		};
	},
	remoteOf(input) {
		return input.ref.remote;
	},
	async run(input, { target, api, commandWith }) {
		// Forgejo 16 has no page or limit on this endpoint: it returns every comment.
		const comments = await api.get<ApiComment[]>(
			`/repos/${target.owner}/${target.name}/issues/${input.ref.number}/comments`,
		);
		// Filter before paging, so total, offsets, and next count only the matches.
		const matches = comments.filter(
			(c) =>
				(input.author === undefined ||
					authorName(c)?.toLowerCase() === input.author) &&
				(input.contains === undefined ||
					(c.body ?? "").toLowerCase().includes(input.contains)),
		);
		const items = matches.map((c) =>
			fitItem(
				pick(
					{
						id: c.id,
						author: authorName(c),
						created_at: c.created_at,
						updated_at: c.updated_at,
						url: c.html_url,
						...truncateBody(c.body, input.bodyMax),
						attachments: attachmentsOf(c),
					},
					input.fields,
				),
			),
		);
		const arg = [input.ref.canonical];
		const offset =
			input.last === undefined
				? input.offset
				: Math.max(0, items.length - input.last);
		const limit = input.last ?? input.limit;
		// After --last, the rest of the thread is exactly what is left to show.
		const nextFor = (end: number) =>
			input.last === undefined
				? commandWith({ offset: end }, arg)
				: commandWith(
						{ last: undefined, offset: end, limit: items.length - end },
						arg,
					);
		const result: Record<string, unknown> = {
			...page(items, offset, limit, nextFor),
		};
		const shown = result.items as Record<string, unknown>[];
		const cut = shown.findIndex((c) => c.body_truncated === true);
		const item = shown[cut];
		if (item) {
			const chars = Number(item.body_chars);
			// Hint while a larger --body-max shows more; at the limit, a hint would
			// repeat itself, so a note says how much fgj shows instead.
			if (input.bodyMax < BODY_MAX_LIMIT) {
				result.hint = commandWith(
					{
						last: undefined,
						offset: offset + cut,
						limit: 1,
						"body-max": BODY_MAX_LIMIT,
					},
					arg,
				);
			}
			if (input.bodyMax >= BODY_MAX_LIMIT || chars > BODY_MAX_LIMIT) {
				const which =
					item.id === undefined ? `at offset ${offset + cut}` : `${item.id}`;
				const shownNow = Array.from(String(item.body)).length;
				result.note =
					chars > BODY_MAX_LIMIT
						? `Comment ${which} is longer than ${BODY_MAX_LIMIT} characters (${chars}); fgj can show at most the first ${BODY_MAX_LIMIT}.`
						: `Comment ${which} is too long for one fgj result (${chars} characters); fgj shows the first ${shownNow}.`;
			}
		}
		return result;
	},
};

/** The `<comment>` argument of the verbs that act on one comment. */
const COMMENT_ARG = {
	name: "comment",
	description:
		"Comment id, in the repository of git origin or --repo, or the comment URL (…#issuecomment-ID).",
};

const GET_FIELDS = {
	all: [
		"id",
		"issue",
		"author",
		"created_at",
		"updated_at",
		"url",
		"body",
		"attachments",
	],
	default: ["id", "issue", "author", "body", "attachments"],
} as const;

interface GetInput {
	ref: CommentRef;
	fields: readonly string[];
	attachmentText: boolean;
}

/** `fgj read comment get <comment>`: one comment, with its whole body for an edit. */
export const commentGet: ReadVerb<GetInput> = {
	risk: "read",
	noun: "comment",
	action: "get",
	summary: "Read one comment, with its whole body.",
	notes: [
		"The body is whole, so you can change it and run comment edit. A body with body_truncated is cut: do not edit from it.",
	],
	args: [COMMENT_ARG],
	flags: [
		{
			name: "fields",
			kind: "fields",
			value: "a,b",
			description: "Comma list of fields. Alone, it lists the fields.",
		},
		{
			name: "attachment-text",
			kind: "bool",
			description: `Add each attachment's content_type, and the text of a text file, up to ${ATTACHMENT_TEXT_MAX} characters. fgj reads it with its token.`,
		},
		REPO_FLAG,
	],
	fields: GET_FIELDS,
	output: `{id, issue, author, body, attachments}; attachments, [{name, size}], only when the comment has any; --attachment-text adds content_type to each, text to a text file, and text_truncated with text_chars when a text is cut so the output fits; it never cuts the body for a text. A body over ${BODY_MAX_LIMIT} characters, or over the output cap after JSON escaping, adds body_truncated, body_chars, and a note.`,
	examples: [
		"fgj read comment get 770",
		"fgj read comment get 770 --fields id,updated_at",
		"fgj read comment get 770 --attachment-text",
	],
	prepare(args: ParsedArgs): GetInput {
		const hint = "fgj help comment get";
		return {
			ref: commentRef(args, hint),
			fields: selectFields(args.flags.fields, GET_FIELDS, hint),
			attachmentText: args.flags["attachment-text"] === true,
		};
	},
	remoteOf(input) {
		return input.ref.remote;
	},
	async run(input, { target, api }) {
		const c = plainComment(
			await api.get<ApiComment | null>(
				`/repos/${target.owner}/${target.name}/issues/comments/${input.ref.id}`,
			),
			input.ref,
			target,
			"fgj help comment get",
		);
		const texts =
			input.attachmentText &&
			input.fields.includes("attachments") &&
			(c.assets ?? []).length > 0;
		const fitted = fitItem(
			pick(
				{
					id: c.id,
					issue: issueOf(c),
					author: authorName(c),
					created_at: c.created_at,
					updated_at: c.updated_at,
					url: c.html_url,
					...truncateBody(c.body, BODY_MAX_LIMIT),
					attachments: texts ? undefined : attachmentsOf(c),
				},
				input.fields,
			),
		);
		const shown = Array.from(String(fitted.body)).length;
		const item =
			fitted.body_truncated === true
				? {
						...fitted,
						note: `fgj shows the first ${shown} of ${String(fitted.body_chars)} characters. Do not edit this comment from this body: the edit would delete the rest.`,
					}
				: fitted;
		if (!texts) return item;
		return {
			...item,
			attachments: fitAttachmentTexts(item, await readAttachments(api, c)),
		};
	},
};

interface AddInput {
	ref: IssueRef;
	body: string;
	dryRun: boolean;
}

/**
 * `fgj write comment add <issue> --body-file PATH`: adds a comment. A retry is
 * safe: when the latest comment is yours with the same body, nothing is posted.
 */
export const commentAdd: WriteVerb<AddInput> = {
	risk: "write",
	noun: "comment",
	action: "add",
	summary:
		"Add a comment from a file. A repeat of your latest comment returns changed:false.",
	args: [
		{
			name: "issue",
			description: "Issue or pull request number, or its URL.",
		},
	],
	flags: [BODY_FILE_FLAG, DRY_RUN_FLAG, REPO_FLAG],
	output:
		"{changed, issue, id, url}. changed:false means your latest comment already had this body. --dry-run: {dry_run, changed, issue, url, body_chars, apply}.",
	examples: [
		"fgj write comment add 157 --body-file /tmp/decision.md",
		"fgj write comment add 157 --body-file /tmp/decision.md --dry-run",
	],
	prepare(args: ParsedArgs, local: LocalEnv): AddInput {
		const hint = "fgj help comment add";
		return {
			ref: issueRef(args, hint),
			body: readBodyFile(args.flags["body-file"], local, hint),
			dryRun: args.flags["dry-run"] === true,
		};
	},
	remoteOf(input) {
		return input.ref.remote;
	},
	async run(input, { target, api, commandWith }) {
		const repoPath = `/repos/${target.owner}/${target.name}`;
		const path = `${repoPath}/issues/${input.ref.number}/comments`;
		const [me, comments] = await Promise.all([
			api.send<{ login: string }>("GET", "/user"),
			api.send<ApiComment[]>("GET", path),
		]);
		const latest = comments.at(-1);
		const repeat =
			latest !== undefined &&
			latest.user?.login === me.login &&
			(latest.body ?? "") === input.body;
		if (input.dryRun) {
			// A repeat sends nothing, so only a real send can be refused.
			if (!repeat) api.assertSendable({ body: input.body });
			return {
				dry_run: true,
				changed: !repeat,
				issue: input.ref.number,
				url: `${target.baseUrl}/${target.owner}/${target.name}/issues/${input.ref.number}`,
				body_chars: Array.from(input.body).length,
				apply: commandWith({ "dry-run": undefined }, [input.ref.canonical]),
			};
		}
		if (repeat) {
			return {
				changed: false,
				issue: input.ref.number,
				id: latest.id,
				url: latest.html_url,
			};
		}
		const created = await api.send<ApiComment>("POST", path, {
			body: input.body,
		});
		return {
			changed: true,
			issue: input.ref.number,
			id: created.id,
			url: created.html_url,
		};
	},
};

/**
 * Checks that a comment read is a plain issue comment, and that it sits on the
 * issue that a comment URL names. Forgejo answers a review comment or a
 * timeline event with an empty 204, so the client returns `null` for it.
 */
function plainComment(
	comment: ApiComment | null,
	ref: CommentRef,
	target: Target,
	hint: string,
): ApiComment {
	if (comment === null) {
		throw new FgjError(
			"usage",
			`Comment ${ref.id} in ${target.owner}/${target.name} is a review comment or an event. fgj reads and changes plain issue comments only.`,
			hint,
		);
	}
	const issue = issueOf(comment);
	if (ref.issue !== undefined && issue !== ref.issue) {
		throw new FgjError(
			"usage",
			`The URL names issue ${ref.issue}, but comment ${ref.id} is on issue ${issue}. Use the comment's own URL.`,
			hint,
		);
	}
	return comment;
}

/**
 * Reads a comment and checks that the caller wrote it. Forgejo lets every
 * write collaborator change every comment, so fgj adds this check: a `write`
 * call runs with no prompt, and a `destroy` prompt does not show the author.
 */
async function ownComment(
	api: WriteApi,
	target: Target,
	ref: CommentRef,
	hint: string,
): Promise<ApiComment> {
	const [me, raw] = await Promise.all([
		api.send<{ login: string }>("GET", "/user"),
		api.send<ApiComment | null>(
			"GET",
			`/repos/${target.owner}/${target.name}/issues/comments/${ref.id}`,
		),
	]);
	const comment = plainComment(raw, ref, target, hint);
	// A migrated comment keeps its original author's name; it is not the caller's.
	if (comment.original_author) {
		throw new FgjError(
			"conflict",
			`Comment ${ref.id} was migrated from another forge (author ${comment.original_author}). fgj changes only your own comments.`,
			hint,
		);
	}
	if (comment.user?.login !== me.login) {
		throw new FgjError(
			"conflict",
			`Comment ${ref.id} is by ${authorName(comment) ?? "an unknown author"}, not by ${me.login}. fgj changes only your own comments.`,
			hint,
		);
	}
	return comment;
}

interface EditInput {
	ref: CommentRef;
	body: string;
	dryRun: boolean;
}

/**
 * `fgj write comment edit <comment> --body-file PATH`: replaces the body of
 * the caller's own comment. The same body sends nothing, so a retry is safe.
 */
export const commentEdit: WriteVerb<EditInput> = {
	risk: "write",
	noun: "comment",
	action: "edit",
	summary:
		"Replace the body of your own comment from a file. The same body returns changed:false.",
	notes: [
		"Another author's comment fails with conflict (exit 5), and nothing changes.",
		"To change part of a comment, run comment get first: it returns the whole body.",
	],
	args: [COMMENT_ARG],
	flags: [BODY_FILE_FLAG, DRY_RUN_FLAG, REPO_FLAG],
	output:
		"{changed, id}. changed:false means the comment already had this body. --dry-run: {dry_run, changed, id, body_chars, apply}.",
	examples: [
		"fgj write comment edit 770 --body-file /tmp/list.md",
		"fgj write comment edit 770 --body-file /tmp/list.md --dry-run",
	],
	prepare(args: ParsedArgs, local: LocalEnv): EditInput {
		const hint = "fgj help comment edit";
		return {
			ref: commentRef(args, hint),
			body: readBodyFile(args.flags["body-file"], local, hint),
			dryRun: args.flags["dry-run"] === true,
		};
	},
	remoteOf(input) {
		return input.ref.remote;
	},
	async run(input, { target, api, commandWith }) {
		const hint = "fgj help comment edit";
		const comment = await ownComment(api, target, input.ref, hint);
		const changed = (comment.body ?? "") !== input.body;
		if (input.dryRun) {
			// The same body sends nothing, so only a real send can be refused.
			if (changed) api.assertSendable({ body: input.body });
			return {
				dry_run: true,
				changed,
				id: comment.id,
				body_chars: Array.from(input.body).length,
				apply: commandWith({ "dry-run": undefined }, [input.ref.canonical]),
			};
		}
		if (changed) {
			await api.send(
				"PATCH",
				`/repos/${target.owner}/${target.name}/issues/comments/${comment.id}`,
				{ body: input.body },
			);
		}
		return { changed, id: comment.id };
	},
};

interface AttachInput {
	ref: CommentRef;
	file: { name: string; text: string; size: number };
	dryRun: boolean;
}

/** A Forgejo attachment, reduced to the keys fgj reads. */
interface ApiAsset {
	id: number;
	name: string;
	size: number;
	browser_download_url: string;
}

/** The instance's attachment settings, from `/settings/attachment`. */
interface AttachmentSettings {
	enabled: boolean;
	allowed_types: string;
	/** In megabytes. */
	max_size: number;
}

/**
 * Checks a file against the instance's attachment settings before an upload.
 * The server checks the type, by extension or by sniffed content, but never the
 * size; fgj checks both, and leaves MIME entries to the server.
 */
function checkAttachment(
	settings: AttachmentSettings,
	file: AttachInput["file"],
	hint: string,
): void {
	if (!settings.enabled) {
		throw new FgjError(
			"conflict",
			"Attachments are disabled on this Forgejo instance. Put the evidence in the comment body instead.",
			hint,
		);
	}
	const limit =
		settings.max_size > 0
			? Math.min(BODY_FILE_MAX_BYTES, settings.max_size * 1024 * 1024)
			: BODY_FILE_MAX_BYTES;
	if (file.size > limit) {
		throw new FgjError(
			"usage",
			`The file ${file.name} has ${file.size} bytes; the limit is ${limit}.`,
			hint,
		);
	}
	const entries = settings.allowed_types
		.split(/[,|]/)
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	const ext = extname(file.name).toLowerCase();
	const allowed =
		entries.length === 0 ||
		entries.includes("*/*") ||
		entries.includes(ext) ||
		// A MIME or wildcard entry needs the file's content: the server decides.
		entries.some((e) => !e.startsWith("."));
	if (!allowed) {
		throw new FgjError(
			"usage",
			`This Forgejo instance does not allow ${ext || "files with no extension"} attachments. Allowed: ${entries.join(", ")}.`,
			hint,
		);
	}
}

/**
 * `fgj write comment attach <comment> --file PATH`: uploads one text file to
 * the caller's own comment. The same file name and size on the comment sends
 * nothing, so a retry is safe.
 */
export const commentAttach: WriteVerb<AttachInput> = {
	risk: "write",
	noun: "comment",
	action: "attach",
	summary:
		"Upload a text file to your own comment. The same file again returns changed:false.",
	notes: [
		"The file must be UTF-8 text of at most 1 MiB, with a type that the instance allows, such as .md, .txt, .log, .json, or .csv. Another author's comment fails with conflict (exit 5).",
		"url is the download link; add it to the comment body with comment edit when the readers need it there. fgj read comment get --attachment-text reads the files back as text.",
		"An upload changes the comment's updated_at and sends an issue_comment edited webhook. The body stays the same.",
	],
	args: [COMMENT_ARG],
	flags: [
		{
			name: "file",
			kind: "string",
			value: "PATH",
			description:
				"The text file to upload. Its name is the attachment name. A quoted ~/ means the home directory.",
			required: true,
		},
		DRY_RUN_FLAG,
		REPO_FLAG,
	],
	output:
		"{changed, id, comment, name, size, url}. changed:false means the comment already had a file with this name and size. --dry-run: {dry_run, changed, comment, name, size, apply}.",
	examples: [
		"fgj write comment attach 770 --file /tmp/test-log.md",
		"fgj write comment attach 770 --file /tmp/test-log.md --dry-run",
	],
	prepare(args: ParsedArgs, local: LocalEnv): AttachInput {
		const hint = "fgj help comment attach";
		const read: TextFile = readTextFile(args.flags.file, local, hint, {
			kind: "file",
			missing: "Missing --file PATH. Write the evidence to a text file first.",
		});
		return {
			ref: commentRef(args, hint),
			file: { name: basename(read.path), text: read.text, size: read.size },
			dryRun: args.flags["dry-run"] === true,
		};
	},
	remoteOf(input) {
		return input.ref.remote;
	},
	async run(input, { target, api, commandWith }) {
		const hint = "fgj help comment attach";
		const comment = await ownComment(api, target, input.ref, hint);
		const assetsPath = `/repos/${target.owner}/${target.name}/issues/comments/${comment.id}/assets`;
		// Any valid token reads the settings; a host that needs sign-in refuses none.
		const settings = await api.get<AttachmentSettings>("/settings/attachment");
		checkAttachment(settings, input.file, hint);
		const existing = (await api.get<ApiAsset[]>(assetsPath)).find(
			(a) => a.name === input.file.name && a.size === input.file.size,
		);
		const shown = {
			comment: comment.id,
			name: input.file.name,
			size: input.file.size,
		};
		if (input.dryRun) {
			if (!existing) api.assertSendable({ text: input.file.text });
			return {
				dry_run: true,
				changed: !existing,
				...shown,
				apply: commandWith({ "dry-run": undefined }, [input.ref.canonical]),
			};
		}
		if (existing) {
			return {
				changed: false,
				id: existing.id,
				...shown,
				url: existing.browser_download_url,
			};
		}
		let created: ApiAsset;
		try {
			created = await api.upload<ApiAsset>(
				assetsPath,
				"attachment",
				input.file,
			);
		} catch (err) {
			// MIME entries in allowed_types leave the type check to the server.
			if (err instanceof FgjError && err.status === 422) {
				throw new FgjError(
					"usage",
					`This Forgejo instance does not allow the type of ${input.file.name}. ${err.message}`,
					hint,
				);
			}
			throw err;
		}
		return {
			changed: true,
			id: created.id,
			...shown,
			url: created.browser_download_url,
		};
	},
};

interface DeleteInput {
	ref: CommentRef;
	dryRun: boolean;
}

/**
 * `fgj destroy comment delete <comment>`: deletes the caller's own comment. A
 * missing comment returns changed:false, so a retry is safe.
 */
export const commentDelete: WriteVerb<DeleteInput> = {
	risk: "destroy",
	noun: "comment",
	action: "delete",
	summary:
		"Delete your own comment. A missing comment returns changed:false. No undo.",
	effect: {
		now: "Deletes comment $1",
		plan: "Plans to delete comment $1",
		arg: COMMENT_ARG_SHAPE,
	},
	notes: [
		"The harness asks a human for each call, --dry-run too. Run --dry-run first and show the plan.",
		"Another author's comment fails with conflict (exit 5), and nothing changes.",
	],
	args: [COMMENT_ARG],
	flags: [DRY_RUN_FLAG, REPO_FLAG],
	output:
		"{changed, id}. changed:false means Forgejo has no comment with this id. A comment in another repository fails with not_found. --dry-run: {dry_run, changed, id, issue, created_at, url, apply}.",
	examples: [
		"fgj destroy comment delete 770 --dry-run",
		"fgj destroy comment delete 770",
	],
	prepare(args: ParsedArgs): DeleteInput {
		return {
			ref: commentRef(args, "fgj help comment delete"),
			dryRun: args.flags["dry-run"] === true,
		};
	},
	remoteOf(input) {
		return input.ref.remote;
	},
	async run(input, { target, api, commandWith }) {
		const hint = "fgj help comment delete";
		const repoPath = `/repos/${target.owner}/${target.name}`;
		const apply = commandWith({ "dry-run": undefined }, [input.ref.canonical]);
		// Comment ids are global. Forgejo says "comment does not exist" only when
		// the id is gone everywhere; a comment in another repository, or a
		// repository you cannot see, gets a 404 without it. Only the first is done.
		const gone = (err: unknown) => {
			if (!(err instanceof FgjError && err.code === "not_found")) throw err;
			if (!/comment does not exist/.test(err.message)) {
				throw new FgjError(
					"not_found",
					`No comment ${input.ref.id} in ${target.owner}/${target.name}. A bare id resolves in the repository of git origin or --repo; pass the comment URL.`,
					hint,
				);
			}
			return input.dryRun
				? { dry_run: true, changed: false, id: input.ref.id, apply }
				: { changed: false, id: input.ref.id };
		};
		let comment: ApiComment;
		try {
			comment = await ownComment(api, target, input.ref, hint);
		} catch (err) {
			return gone(err);
		}
		if (input.dryRun) {
			return {
				dry_run: true,
				changed: true,
				id: comment.id,
				issue: issueOf(comment),
				created_at: comment.created_at,
				url: comment.html_url,
				apply,
			};
		}
		try {
			await api.send("DELETE", `${repoPath}/issues/comments/${comment.id}`);
		} catch (err) {
			// Another call deleted it after the read: the result is the same.
			return gone(err);
		}
		return { changed: true, id: comment.id };
	},
};

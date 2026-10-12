import { FgjError } from "../core/errors.ts";
import { OUTPUT_CAP } from "../core/output.ts";
import type { ParsedArgs, ReadVerb } from "../core/verb.ts";
import { REPO_FLAG } from "./common.ts";

const HINT = "fgj help api get";

/** One path segment: a name, a number, or a SHA, and never `.` or `..`. */
const SEG = String.raw`(?!\.\.?(?:/|$))[A-Za-z0-9._~-]+`;
/** One or more segments, for a branch, a tag, a ref, or a file path. */
const PATH = `${SEG}(?:/${SEG})*`;
const N = String.raw`[1-9]\d{0,14}`;

/**
 * The repository-relative GET families that `api get` reads. It is an accept
 * list: Forgejo returns Actions variable values to a read token, so any path
 * outside the list fails before any request.
 */
const FAMILIES: readonly [string, string][] = [
	[".", String.raw`\.`],
	["commits/<ref>/status", `commits/${SEG}/status`],
	["commits/<ref>/statuses", `commits/${SEG}/statuses`],
	["statuses/<sha>", `statuses/${SEG}`],
	["commits[/<sha>]", `commits(?:/${SEG})?`],
	["actions/runs[/<id>[/jobs]]", `actions/runs(?:/${N}(?:/jobs)?)?`],
	["actions/tasks", "actions/tasks"],
	["pulls", "pulls"],
	[
		"pulls/<n>/{files,reviews,comments,commits}",
		`pulls/${N}/(?:files|reviews|comments|commits)`,
	],
	["issues/<n>/timeline", `issues/${N}/timeline`],
	["issues/comments", "issues/comments"],
	["branches[/<name>]", `branches(?:/${PATH})?`],
	["branch_protections[/<name>]", `branch_protections(?:/${PATH})?`],
	["contents[/<path>]", `contents(?:/${PATH})?`],
	["git/trees/<sha>", `git/trees/${SEG}`],
	["tags", "tags"],
	["releases[/tags/<tag>]", `releases(?:/tags/${PATH})?`],
	["milestones", "milestones"],
	["collaborators", "collaborators"],
	["labels/<id>", `labels/${N}`],
	["wiki/pages", "wiki/pages"],
];

/**
 * The families that wrap a list in an object with `total_count` and page only
 * by `page` and `limit`, with no `Link` header. Without a page they list
 * everything, so fgj always sends one, and it builds `next` from `total_count`.
 */
const WRAPPERS: Readonly<Record<string, string>> = {
	"actions/runs": "workflow_runs",
	"actions/tasks": "workflow_runs",
};

const FAMILY_RE = new RegExp(`^(?:${FAMILIES.map(([, re]) => re).join("|")})$`);

/**
 * Checks a repository-relative path against the accept list.
 *
 * @param raw - The path as the caller wrote it, for example `pulls/10/commits`.
 * @returns The path, or `""` for the repository itself (`.`).
 * @throws {FgjError} A usage error that lists the families, before any request.
 * @example
 * repoPath("pulls/10/commits"); // "pulls/10/commits"
 */
export function repoPath(raw: string): string {
	if (!FAMILY_RE.test(raw)) {
		throw new FgjError(
			"usage",
			`"${raw}" is not a path that fgj api get reads. Give a path relative to the repository from this list: ${FAMILIES.map(([name]) => name).join(", ")}.`,
			HINT,
		);
	}
	return raw === "." ? "" : raw;
}

/** A dotted field path, as a list of keys. */
type FieldPath = readonly string[];

/**
 * Keeps only the named fields of a JSON value. A dotted path reaches into an
 * object, and through an array it applies to each element, so
 * `commit.message` keeps `{commit: {message}}` for every item.
 *
 * @param value - The JSON value.
 * @param paths - The dotted paths, each as a list of keys.
 * @returns A copy with only those fields, in the value's own key order.
 * @example
 * selectPaths([{ sha: "a", x: 1, commit: { message: "m", tree: {} } }], [["sha"], ["commit", "message"]]);
 * // [{ sha: "a", commit: { message: "m" } }]
 */
export function selectPaths(
	value: unknown,
	paths: readonly FieldPath[],
): unknown {
	if (Array.isArray(value)) return value.map((v) => selectPaths(v, paths));
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, inner] of Object.entries(value)) {
		const here = paths.filter((p) => p[0] === key);
		if (here.length === 0) continue;
		const rest = here.map((p) => p.slice(1));
		out[key] = rest.some((r) => r.length === 0)
			? inner
			: selectPaths(inner, rest);
	}
	return out;
}

/** The page number that a `Link` header names for `rel="next"`, if any. */
function nextPage(link: string | null): string | undefined {
	for (const part of (link ?? "").split(",")) {
		if (!/rel="next"/.test(part)) continue;
		const url = /<([^>]+)>/.exec(part)?.[1];
		const page = url
			? new URL(url, "http://link.invalid").searchParams.get("page")
			: null;
		if (page && /^\d+$/.test(page)) return page;
	}
	return undefined;
}

/**
 * The query keys that `api get` sends: the ones agents use on these families.
 * An accept list, because Forgejo reads `token`, `access_token`, and `sudo`
 * from the query, and they would change the account that a call runs as.
 */
const QUERY_KEYS = [
	"limit",
	"page",
	"state",
	"ref",
	"sha",
	"path",
	"q",
	"type",
	"sort",
	"order",
	"labels",
	"milestones",
	"branch",
	"event",
	"status",
	"head",
	"head_sha",
	"run_number",
	"workflow_id",
	"stat",
	"verification",
	"files",
	"recursive",
	"since",
	"before",
	"per_page",
] as const;

/** Room for the envelope that the dispatcher adds, such as `"as":"…"`. */
const ENVELOPE = 200;

/**
 * The query for a smaller page that still starts at the same first item: the
 * new size divides the page size that the server used, and the page moves to
 * match. `per_page` stays the key when the query uses it.
 *
 * @param query - The call's query.
 * @param served - The page size that the server used for this call.
 * @param factor - How many times too big the result is, rounded up.
 * @param fit - The most items that fit under the cap, when the item size is known.
 * @returns The query with a smaller page size, and a moved `page` when needed.
 * @example
 * shrinkQuery([["limit", "100"], ["page", "2"]], 50, 2); // [["limit", "25"], ["page", "3"]]
 */
export function shrinkQuery(
	query: readonly [string, string][],
	served: number,
	factor: number,
	fit?: number,
): [string, string][] {
	const key = query.some(([k]) => k === "per_page") ? "per_page" : "limit";
	const scaled = Math.floor(served / Math.max(2, factor));
	const want = Math.max(1, fit === undefined ? scaled : Math.min(scaled, fit));
	const page = Number(query.find(([k]) => k === "page")?.[1] ?? "1");
	const first = (Math.max(1, page) - 1) * served;
	// Past page 1, the new size must divide the served one to start at the same item.
	let fewer = want;
	while (first > 0 && fewer > 1 && served % fewer !== 0) fewer--;
	const out = query.filter(([k]) => k !== key && k !== "page");
	out.push([key, String(fewer)]);
	if (first > 0) out.push(["page", String(first / fewer + 1)]);
	return out;
}

/**
 * Shapes a response: an array becomes `{items, total, next}`, and an object
 * on a paged endpoint gains `next` from `Link`, as a wrapper such as
 * `{total_count, workflow_runs}` does.
 *
 * @param kept - The response after `--fields`.
 * @param link - The `Link` header, if any.
 * @param total - `X-Total-Count`, if sent.
 * @param command - Builds the command for a query.
 * @param query - The call's query.
 * @returns The result object.
 * @example
 * shapeResult([{ sha: "a" }], null, 1, cmd, []); // { items: [{ sha: "a" }], total: 1, next: null }
 */
export function shapeResult(
	kept: unknown,
	link: string | null,
	total: number | undefined,
	command: (query: [string, string][]) => string,
	query: readonly [string, string][],
): Record<string, unknown> {
	const page = nextPage(link);
	const next =
		page === undefined
			? null
			: command(
					query.some(([k]) => k === "page")
						? query.map(([k, v]): [string, string] => [
								k,
								k === "page" ? page : v,
							])
						: [...query, ["page", page]],
				);
	if (Array.isArray(kept)) {
		return { items: kept, ...(total === undefined ? {} : { total }), next };
	}
	if (kept !== null && typeof kept === "object") {
		const out = kept as Record<string, unknown>;
		return next !== null && !("next" in out) ? { ...out, next } : out;
	}
	return { value: kept };
}

/**
 * True when a field path reaches its last key somewhere in the value. Through
 * an array, any item counts; an empty array cannot show a miss, so it counts.
 */
function pathMatches(value: unknown, path: FieldPath): boolean {
	if (Array.isArray(value)) {
		return value.length === 0 || value.some((v) => pathMatches(v, path));
	}
	if (value === null || typeof value !== "object") return false;
	const [key, ...rest] = path as [string, ...string[]];
	if (!Object.hasOwn(value, key)) return false;
	const inner = (value as Record<string, unknown>)[key];
	// A present null, such as a PR with no milestone, is a match, not a typo.
	return rest.length === 0 || inner === null || pathMatches(inner, rest);
}

/**
 * The error for --fields that match nothing. When the response wraps its
 * items in one array key, such as `workflow_runs`, and the fields are inside
 * those items, the hint names them under that key.
 */
function noFieldMatched(
	data: unknown,
	fields: readonly FieldPath[],
	command: (fields: string) => string,
): FgjError {
	const describe = (v: unknown): string =>
		v !== null && typeof v === "object"
			? Object.entries(Array.isArray(v) ? ((v[0] as object) ?? {}) : v)
					.map(([k, x]) => (Array.isArray(x) ? `${k}[]` : k))
					.join(", ")
			: "no keys";
	const wrappers =
		data !== null && typeof data === "object" && !Array.isArray(data)
			? Object.entries(data).filter(
					([, v]) =>
						Array.isArray(v) &&
						v.some(
							(item) =>
								item !== null &&
								typeof item === "object" &&
								fields.some((f) => (f[0] as string) in item),
						),
				)
			: [];
	const [only] = wrappers;
	return new FgjError(
		"usage",
		`No field in --fields matched. The response has: ${describe(data)}.${only ? ` The items sit in ${only[0]}.` : ""}`,
		wrappers.length === 1 && only
			? command(fields.map((f) => [only[0], ...f].join(".")).join(","))
			: HINT,
	);
}

interface GetInput {
	path: string;
	shown: string;
	query: [string, string][];
	fields: FieldPath[] | undefined;
}

/** `fgj read api get <repo-relative-path>`: a read-only GET that no verb covers. */
export const apiGet: ReadVerb<GetInput> = {
	risk: "read",
	noun: "api",
	action: "get",
	summary:
		"Read a repository GET endpoint that no verb covers, as compact JSON.",
	notes: [
		"The path is relative to the repository: . is the repository itself, and pulls/10/commits is /repos/{owner}/{repo}/pulls/10/commits. Only the listed families work; the error lists them.",
		"--fields takes dotted paths: sha,commit.message keeps {sha, commit:{message}} for each item, and workflow_runs.id reaches into a wrapper array.",
		"A JSON array returns {items, total, next}; next is the command for the next page, or null. actions/runs and actions/tasks keep their {total_count, workflow_runs} shape and also get total and next; for them fgj reads the server's page size from /settings/api, a second request.",
		"A result over the output cap fails: ask for fewer fields with --fields, or fewer items with --query limit=N.",
		"--query takes only known keys, such as limit, page, and state; the error lists them.",
		"commits/<ref>/status takes a SHA or a branch name with no /; for a branch such as feat/x, use its head SHA.",
		"actions/runs/<id> takes the API run id, not the run number in the web UI; actions/tasks lists task ids, a third kind. A web number can be another run's API id, so check index_in_repo in the result. For a run by its web number, use fgj read run get.",
		"--fields that match nothing fail; for a wrapper such as {total_count, workflow_runs}, name the fields inside it: workflow_runs.id.",
		"pulls/10/files lists the changed files of a pull request, with no patch text: --fields filename,status,additions,deletions keeps the list small. Read the changes of a file with git in a checkout.",
		"It reads JSON only, with the read token. Use a verb when one covers the endpoint.",
	],
	args: [
		{
			name: "repo-relative-path",
			description:
				"The path after /repos/{owner}/{repo}/, or . for the repository.",
		},
	],
	flags: [
		{
			name: "query",
			kind: "list",
			value: "k=v",
			description: "A query parameter. Repeat it for more.",
		},
		{
			name: "fields",
			kind: "string",
			value: "a,b.c",
			description: "Comma list of dotted field paths to keep.",
		},
		REPO_FLAG,
	],
	output:
		"The JSON object, or {items, total, next} for a JSON array, with only --fields when given.",
	examples: [
		"fgj read api get . --fields full_name,default_branch,html_url",
		"fgj read api get pulls/10/commits --query limit=40 --fields sha,commit.message",
	],
	prepare(args: ParsedArgs): GetInput {
		if (args.positionals.length !== 1) {
			throw new FgjError(
				"usage",
				`Expected one repository-relative path, got ${args.positionals.length}.`,
				HINT,
			);
		}
		const shown = args.positionals[0] as string;
		const path = repoPath(shown);
		const raw = args.flags.query;
		const query = (Array.isArray(raw) ? raw : []).map((q): [string, string] => {
			const m = /^([a-z][a-z0-9_]*)=([^\s]*)$/.exec(q);
			if (!m) {
				throw new FgjError(
					"usage",
					`--query needs key=value with a lowercase key, got "${q}".`,
					HINT,
				);
			}
			if (!(QUERY_KEYS as readonly string[]).includes(m[1] as string)) {
				throw new FgjError(
					"usage",
					`--query ${m[1]} is not a key that fgj api get sends. Keys: ${QUERY_KEYS.join(", ")}.`,
					HINT,
				);
			}
			return [m[1] as string, m[2] as string];
		});
		const page = query.find(([k]) => k === "page")?.[1];
		if (page !== undefined && !/^[1-9]\d{0,6}$/.test(page)) {
			// Forgejo does not page at 0: a wrapper family then lists everything.
			throw new FgjError(
				"usage",
				`--query page takes 1 or more, got "${page}".`,
				HINT,
			);
		}
		const keys = query.map(([k]) => k);
		if (new Set(keys).size !== keys.length) {
			throw new FgjError("usage", "A --query key appears twice.", HINT);
		}
		// Each endpoint reads one page-size key and ignores the other; a hint
		// that shrank the ignored one would skip items.
		const sizeKey = /^git\/trees\//.test(path) ? "per_page" : "limit";
		const other = sizeKey === "limit" ? "per_page" : "limit";
		if (keys.includes(other)) {
			throw new FgjError(
				"usage",
				`${shown} pages with --query ${sizeKey}=N; it ignores ${other}.`,
				HINT,
			);
		}
		const f = args.flags.fields;
		let fields: FieldPath[] | undefined;
		if (f !== undefined) {
			const list =
				typeof f === "string" ? f.split(",").map((x) => x.trim()) : [];
			if (
				list.length === 0 ||
				list.some((x) => !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(x))
			) {
				throw new FgjError(
					"usage",
					"--fields needs a comma list of field paths, for example sha,commit.message.",
					HINT,
				);
			}
			fields = list.map((x) => x.split("."));
		}
		return { path, shown, query, fields };
	},
	async run(input, { target, api, commandWith, commandFor }) {
		const base = `/repos/${target.owner}/${target.name}`;
		const sizeKey = /^git\/trees\//.test(input.path) ? "per_page" : "limit";
		// A wrapper family pages only with a page parameter: without one it
		// lists everything, and it ignores limit. Other lists read page 1 when
		// none is given, so fgj sends it with a size, and always on a wrapper.
		const wrapper = WRAPPERS[input.path];
		const paged =
			wrapper !== undefined || input.query.some(([k]) => k === sizeKey);
		const sent: [string, string][] =
			paged && !input.query.some(([k]) => k === "page")
				? [...input.query, ["page", "1"]]
				: input.query;
		let got: Awaited<ReturnType<typeof api.getPaged>>;
		try {
			got = await api.getPaged(
				input.path ? `${base}/${input.path}` : base,
				sent.length > 0 ? Object.fromEntries(sent) : undefined,
			);
		} catch (err) {
			const run = /^actions\/runs\/(\d+)/.exec(input.path)?.[1];
			if (run && err instanceof FgjError && err.code === "not_found") {
				throw new FgjError(
					"not_found",
					`Nothing at actions/runs/${run} in ${target.owner}/${target.name}: no run has API run id ${run}, or the repository does not exist. actions/runs/<id> takes the API run id, not the run number in the web UI; fgj read run get takes that number.`,
					commandFor("read run get", [run]),
				);
			}
			throw err;
		}
		const { data, link, total } = got;
		const kept = input.fields ? selectPaths(data, input.fields) : data;
		if (input.fields && !input.fields.some((f) => pathMatches(data, f))) {
			throw noFieldMatched(data, input.fields, (fields) =>
				commandWith({ fields }, [input.shown]),
			);
		}
		const withQuery = (q: [string, string][]) =>
			commandWith({ query: q.map(([k, v]) => `${k}=${v}`) }, [input.shown]);
		const out = shapeResult(kept, link, total, withQuery, input.query);
		// The wrapped list: its items on this page, and the total over all pages.
		const listed =
			wrapper && data !== null && typeof data === "object"
				? (data as Record<string, unknown>)[wrapper]
				: undefined;
		const count = Array.isArray(listed) ? listed.length : undefined;
		// The page size that the server used: the limit asked, or its default,
		// capped at its max_response_items. A short page cannot show it.
		let wrapSize: number | undefined;
		if (count !== undefined) {
			const all = (data as { total_count?: unknown }).total_count;
			const asked = Number(input.query.find(([k]) => k === sizeKey)?.[1]);
			const page = Number(input.query.find(([k]) => k === "page")?.[1] ?? "1");
			const settings = await api.get<{
				default_paging_num?: unknown;
				max_response_items?: unknown;
			}>("/settings/api");
			const whole = (v: unknown) =>
				typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
			const fallback = whole(settings.default_paging_num);
			const max = whole(settings.max_response_items);
			const wanted = asked > 0 ? asked : fallback;
			wrapSize =
				wanted !== undefined && max !== undefined
					? Math.min(wanted, max)
					: undefined;
			const more =
				typeof all === "number" &&
				wrapSize !== undefined &&
				count > 0 &&
				(page - 1) * wrapSize + count < all;
			if (typeof all === "number") out.total = all;
			out.next = more
				? withQuery([
						...input.query.filter(([k]) => k !== "page"),
						["page", String(page + 1)],
					])
				: null;
		}
		const size = JSON.stringify(out).length + ENVELOPE;
		if (size > OUTPUT_CAP) {
			// The hint uses only facts from this response, because each endpoint
			// caps and defaults its page size in its own way. On page 1 there is no
			// position to keep. Past page 1, only a full page (one with a next page)
			// shows the size the server used: its item count.
			const asked = Number(input.query.find(([k]) => k === sizeKey)?.[1]);
			const page = Number(input.query.find(([k]) => k === "page")?.[1] ?? "1");
			// A wrapper family holds its items in its list: count those, not the
			// limit asked, which the server can cut. Any other object is one item.
			const items = Array.isArray(kept) ? kept.length : count;
			// Page 1 has no position to keep, so the items on it set the scale.
			// Past page 1, the new size must start at the same item: that needs
			// the size the server used, which a wrapper family knows.
			const served =
				page > 1
					? (wrapSize ??
						(items !== undefined && out.next !== null ? items : undefined))
					: (items ?? (asked > 0 ? asked : undefined));
			// The size of one item comes from the items on this page.
			const perItem = items
				? (size - ENVELOPE) / items
				: served
					? (size - ENVELOPE) / served
					: undefined;
			const fit =
				perItem !== undefined
					? Math.floor((OUTPUT_CAP - ENVELOPE) / perItem)
					: undefined;
			const smaller = served
				? shrinkQuery(input.query, served, Math.ceil(size / OUTPUT_CAP), fit)
				: undefined;
			// A hint that asks for no fewer items would repeat this call, and one
			// that still passes the cap would fail again.
			const fewer = Number(smaller?.find(([k]) => k === sizeKey)?.[1]);
			const fits =
				perItem !== undefined && fewer * perItem + ENVELOPE <= OUTPUT_CAP;
			const useful =
				smaller !== undefined && served !== undefined && fewer < served && fits;
			const alone =
				perItem !== undefined && perItem + ENVELOPE > OUTPUT_CAP
					? ` One item is about ${Math.round(perItem)} characters, over the cap by itself.`
					: "";
			throw new FgjError(
				"usage",
				`The result is ${size} characters; the cap is ${OUTPUT_CAP}.${alone} Ask for fewer fields with --fields a,b.c${useful ? `, or fewer items with --query ${sizeKey}=N` : ""}.`,
				useful ? withQuery(smaller) : HINT,
			);
		}
		return out;
	},
};

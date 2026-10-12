import { FgjError } from "../core/errors.ts";
import type { Tracer } from "../core/trace.ts";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Query = Record<string, string | number>;

async function request<T>(
	baseUrl: string,
	token: string,
	trace: Tracer,
	method: Method,
	path: string,
	query?: Query,
	body?: unknown,
	onHeaders?: (headers: Headers) => void,
	asText = false,
): Promise<T> {
	const qs = query
		? `?${new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]))}`
		: "";
	const url = `${baseUrl}/api/v1${path}${qs}`;
	// URL parsing folds . and .. segments, encoded ones too, and a server can
	// decode %2F or %5C. A path that could change could leave the repository.
	const built = `${new URL(baseUrl).pathname.replace(/\/$/, "")}/api/v1${path}`;
	if (new URL(url).pathname !== built || /%(?:2f|5c)/i.test(path)) {
		throw new FgjError(
			"usage",
			`URL parsing would change the request path ${path}, or it holds an encoded / or \\. fgj does not send it.`,
			"fgj help",
		);
	}
	const started = performance.now();
	let res: Response;
	try {
		res = await fetch(url, {
			// A followed 301/302 turns a POST into a GET and can hide a failed write.
			redirect: "manual",
			method,
			// A FormData body sets its own multipart content type with the boundary.
			headers: {
				authorization: `token ${token}`,
				accept: asText ? "text/plain" : "application/json",
				...(body === undefined || body instanceof FormData
					? {}
					: { "content-type": "application/json" }),
			},
			...(body === undefined
				? {}
				: { body: body instanceof FormData ? body : JSON.stringify(body) }),
		});
	} catch (err) {
		trace.emit({ ev: "http", method, path: path + qs, error: String(err) });
		throw new FgjError(
			"api",
			`Cannot reach ${baseUrl} (${String(err)})`,
			"fgj auth status",
		);
	}
	if (res.status >= 300 && res.status < 400) {
		trace.emit({ ev: "http", method, path: path + qs, status: res.status });
		throw new FgjError(
			"api",
			`${baseUrl} answered ${method} ${path} with a redirect (HTTP ${res.status}) to ${res.headers.get("location") ?? "an unknown place"}. Use the Forgejo base URL that it names, usually with https.`,
			"fgj auth status",
		);
	}
	const text = await res.text();
	trace.emit({
		ev: "http",
		method,
		path: path + qs,
		status: res.status,
		ms: Math.round(performance.now() - started),
		bytes: text.length,
		...(res.ok ? {} : { message: serverMessage(text) }),
	});
	if (!res.ok) {
		throw httpError(
			res.status,
			`${method} ${path}: ${serverMessage(text)}`,
			baseUrl,
		);
	}
	onHeaders?.(res.headers);
	if (asText) return text as T;
	if (!text) return null as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new FgjError(
			"api",
			`${method} ${path}: expected JSON from ${baseUrl}, got ${res.headers.get("content-type") ?? "no content type"}. Check that the host is a Forgejo base URL.`,
			"fgj auth status",
		);
	}
}

/** The non-`text/` content types that hold text an agent can read. */
const TEXT_TYPES = new Set([
	"application/json",
	"application/xml",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
	"application/javascript",
]);

/** Whether a content type, without parameters, holds text. */
function isTextType(type: string): boolean {
	return (
		type.startsWith("text/") ||
		TEXT_TYPES.has(type) ||
		type.endsWith("+json") ||
		type.endsWith("+xml")
	);
}

/**
 * The first line of the server's error message, and of its first `errors`
 * entry when there is one, each at most 200 characters. Forgejo often puts the
 * useful reason there, for example "comment does not exist".
 */
function serverMessage(text: string): string {
	let message = text;
	let reason: unknown;
	try {
		const parsed = JSON.parse(text) as {
			message?: unknown;
			errors?: unknown;
			Style?: unknown;
			StdOut?: unknown;
			StdErr?: unknown;
		};
		if (typeof parsed.message === "string") message = parsed.message;
		if (Array.isArray(parsed.errors)) reason = parsed.errors[0];
		// A merge that git refused has no message, only git's output: name the
		// style and git's conflict line.
		if (parsed.message === undefined && typeof parsed.Style === "string") {
			const lines = [parsed.StdOut, parsed.StdErr]
				.flatMap((o) => (typeof o === "string" ? o.split(/[\r\n]+/) : []))
				.map((l) => l.trim());
			const line =
				lines.find((l) => l.startsWith("CONFLICT")) ??
				lines.find((l) => /^(?:error|fatal):/.test(l));
			message = `${parsed.Style} conflict${line ? `: ${line}` : ""}`;
		}
	} catch {
		// The body is not JSON; use the raw text.
	}
	const firstLine = (s: string) =>
		(s.trim().split("\n")[0] ?? "").slice(0, 200);
	const base = firstLine(message);
	return typeof reason === "string" && firstLine(reason)
		? `${base} (${firstLine(reason)})`
		: base;
}

function httpError(status: number, message: string, baseUrl: string): FgjError {
	if (status === 401) {
		return new FgjError(
			"auth",
			`${baseUrl} refused the token (HTTP 401) ${message}. A human must run fgj auth to store a new token.`,
			"fgj auth status",
			status,
		);
	}
	if (status === 403) {
		// A valid token can still get 403: a missing scope, a locked issue, or no access.
		return new FgjError(
			"auth",
			`Forbidden (HTTP 403) ${message}. The token lacks a scope, or the user lacks access.`,
			"fgj auth status",
			status,
		);
	}
	if (status === 404) {
		return new FgjError(
			"not_found",
			`Not found (HTTP 404) ${message}`,
			"fgj help",
			status,
		);
	}
	if (status === 409 || status === 412 || status === 423) {
		// 423: the repository is archived or locked; a retry cannot succeed.
		return new FgjError(
			"conflict",
			`Conflict (HTTP ${status}) ${message}`,
			"fgj help",
			status,
		);
	}
	return new FgjError(
		"api",
		`Forgejo returned HTTP ${status} ${message}`,
		"fgj help",
		status,
	);
}

/** One GET of a list page, with the total from `X-Total-Count`. */
async function listPage<T>(
	baseUrl: string,
	token: string,
	trace: Tracer,
	path: string,
	query: Query,
): Promise<{ items: T[]; total: number }> {
	let total: number | undefined;
	const items = await request<T[]>(
		baseUrl,
		token,
		trace,
		"GET",
		path,
		query,
		undefined,
		(headers) => {
			const raw = headers.get("x-total-count");
			if (raw !== null && /^\d+$/.test(raw)) total = Number(raw);
		},
	);
	if (total === undefined) {
		throw new FgjError(
			"api",
			`GET ${path}: ${baseUrl} sent no X-Total-Count header. Check that the host is a Forgejo base URL.`,
			"fgj auth status",
		);
	}
	return { items: items ?? [], total };
}

/** One GET of a JSON body, with `X-Total-Count` when the server sends it. */
async function countedGet<T>(
	baseUrl: string,
	token: string,
	trace: Tracer,
	path: string,
	query?: Query,
): Promise<{ data: T; total?: number }> {
	let total: number | undefined;
	const data = await request<T>(
		baseUrl,
		token,
		trace,
		"GET",
		path,
		query,
		undefined,
		(headers) => {
			const raw = headers.get("x-total-count");
			if (raw !== null && /^\d+$/.test(raw)) total = Number(raw);
		},
	);
	return total === undefined ? { data } : { data, total };
}

/**
 * The client that read verbs get. It can only send GET; the dispatcher gives it
 * the read token.
 *
 * @example
 * const comments = await new ReadApi(baseUrl, readToken, trace).get<Comment[]>(path);
 */
export class ReadApi {
	/**
	 * Makes a client that sends GET requests with the read token.
	 *
	 * @param baseUrl - The Forgejo base URL with no trailing slash, for example `https://git.example.com`.
	 * @param token - The read-scoped token.
	 * @param trace - The tracer for `http` events.
	 * @example
	 * const api = new ReadApi("https://git.example.com", token, trace);
	 */
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly trace: Tracer,
	) {}

	/**
	 * Sends one GET request to `/api/v1`.
	 *
	 * @param path - The path after `/api/v1`, for example `/repos/o/r/issues/1/comments`.
	 * @param query - Query parameters, if any.
	 * @returns The parsed JSON body.
	 * @throws {FgjError} An auth, not_found, conflict, or api error.
	 * @example
	 * const comments = await api.get<Comment[]>("/repos/o/r/issues/1/comments");
	 */
	get<T>(path: string, query?: Query): Promise<T> {
		return request<T>(this.baseUrl, this.token, this.trace, "GET", path, query);
	}

	/**
	 * Sends one GET request for a page of a list, and reads the total from
	 * Forgejo's `X-Total-Count` header.
	 *
	 * @param path - The path after `/api/v1`, for example `/repos/o/r/issues`.
	 * @param query - Query parameters, with `page` and `limit`.
	 * @returns The items of the page, and the number of items in every page.
	 * @throws {FgjError} An auth, not_found, conflict, or api error, or an api
	 *   error when the header is missing.
	 * @example
	 * const { items, total } = await api.list<Issue>("/repos/o/r/issues", { page: 1, limit: 50 });
	 */
	list<T>(path: string, query: Query): Promise<{ items: T[]; total: number }> {
		return listPage<T>(this.baseUrl, this.token, this.trace, path, query);
	}

	/**
	 * Sends one GET request, and reads Forgejo's `X-Total-Count` header when the
	 * server sends one. For a paged body that is not a plain list, such as the
	 * combined commit status.
	 *
	 * @param path - The path after `/api/v1`.
	 * @param query - Query parameters, if any.
	 * @returns The parsed JSON body, and the total when the header is present.
	 * @throws {FgjError} An auth, not_found, conflict, or api error.
	 * @example
	 * const { data, total } = await api.getCounted<{ statuses: unknown[] }>(path, { page: 1, limit: 50 });
	 */
	getCounted<T>(
		path: string,
		query?: Query,
	): Promise<{ data: T; total?: number }> {
		return countedGet<T>(this.baseUrl, this.token, this.trace, path, query);
	}

	/**
	 * Sends one GET request for a plain-text body, such as an Actions job log.
	 *
	 * @param path - The path after `/api/v1`, for example `/repos/o/r/actions/jobs/7/logs`.
	 * @param query - Query parameters, if any.
	 * @returns The body as text.
	 * @throws {FgjError} An auth, not_found, conflict, or api error.
	 * @example
	 * const log = await api.getText("/repos/o/r/actions/jobs/7/logs");
	 */
	getText(path: string, query?: Query): Promise<string> {
		return request<string>(
			this.baseUrl,
			this.token,
			this.trace,
			"GET",
			path,
			query,
			undefined,
			undefined,
			true,
		);
	}

	/**
	 * Reads one attachment's content with the read token. The download URL is a
	 * web route, so an agent with no browser session cannot open it; fgj can.
	 *
	 * @param uuid - The attachment's uuid, from a comment's `assets`.
	 * @returns The content type, without parameters, and the content as text when
	 *   the type is a text type. fgj does not read the content of any other type.
	 * @throws {FgjError} A usage error for a uuid that is not one; an auth error
	 *   when Forgejo answers with its sign-in page; an auth, not_found, or api
	 *   error from the status.
	 * @example
	 * const { content_type, text } = await api.attachmentText("88bf150e-e648-44ea-840b-014854d1b5cc");
	 */
	async attachmentText(
		uuid: string,
	): Promise<{ content_type: string; text?: string }> {
		if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(uuid)) {
			throw new FgjError(
				"usage",
				`"${uuid}" is not an attachment uuid.`,
				"fgj help comment get",
			);
		}
		const path = `/attachments/${uuid}`;
		const started = performance.now();
		let res: Response;
		try {
			res = await fetch(`${this.baseUrl}${path}`, {
				redirect: "manual",
				headers: { authorization: `token ${this.token}` },
			});
		} catch (err) {
			this.trace.emit({ ev: "http", method: "GET", path, error: String(err) });
			throw new FgjError(
				"api",
				`Cannot reach ${this.baseUrl} (${String(err)})`,
				"fgj auth status",
			);
		}
		const contentType = (res.headers.get("content-type") ?? "")
			.split(";")[0]
			?.trim()
			.toLowerCase();
		const type = contentType || "application/octet-stream";
		// Binary content as text is noise to an agent, so fgj does not read it.
		const readsText = !res.ok || isTextType(type);
		const text = readsText ? await res.text() : undefined;
		if (!readsText) await res.body?.cancel();
		this.trace.emit({
			ev: "http",
			method: "GET",
			path,
			status: res.status,
			ms: Math.round(performance.now() - started),
			bytes: text?.length ?? 0,
		});
		// Without a working token, Forgejo answers with its sign-in page, not the file.
		if ((res.status >= 300 && res.status < 400) || type === "text/html") {
			throw new FgjError(
				"auth",
				`${this.baseUrl} answered the attachment ${uuid} with its sign-in page; the read token cannot read it.`,
				"fgj auth status",
			);
		}
		if (!res.ok)
			throw httpError(
				res.status,
				`GET ${path}: ${serverMessage(text ?? "")}`,
				this.baseUrl,
			);
		return text === undefined
			? { content_type: type }
			: { content_type: type, text };
	}

	/**
	 * Sends one GET request and returns the JSON body with the paging headers,
	 * for the read-only passthrough.
	 *
	 * @param path - The path after `/api/v1`.
	 * @param query - Query parameters, if any.
	 * @returns The parsed body, the `Link` header, and `X-Total-Count` when sent.
	 * @throws {FgjError} A usage error when the body is not JSON, or an auth,
	 *   not_found, conflict, or api error.
	 * @example
	 * const { data, link } = await api.getPaged("/repos/o/r/pulls/1/commits", { limit: 4 });
	 */
	async getPaged(
		path: string,
		query?: Query,
	): Promise<{ data: unknown; link: string | null; total?: number }> {
		let link: string | null = null;
		let total: number | undefined;
		let type = "";
		try {
			const data = await request<unknown>(
				this.baseUrl,
				this.token,
				this.trace,
				"GET",
				path,
				query,
				undefined,
				(headers) => {
					link = headers.get("link");
					type = headers.get("content-type") ?? "";
					const raw = headers.get("x-total-count");
					if (raw !== null && /^\d+$/.test(raw)) total = Number(raw);
				},
			);
			if (type && !type.includes("json")) throw new Error("not JSON");
			return total === undefined ? { data, link } : { data, link, total };
		} catch (err) {
			if (type && !type.includes("json")) {
				throw new FgjError(
					"usage",
					`GET ${path} returned ${type.split(";")[0]}, not JSON. fgj api get reads JSON only.`,
					"fgj help api get",
				);
			}
			throw err;
		}
	}
}

/** The refusal for a body that holds a token. */
function tokenInBody(): FgjError {
	return new FgjError(
		"usage",
		"The request body holds a stored or env token. fgj never sends a token in a body.",
		"fgj help",
	);
}

/**
 * The client that write and destroy verbs get. The dispatcher gives it the write token.
 *
 * @example
 * await new WriteApi(baseUrl, writeToken, trace).send("POST", path, { body });
 */
export class WriteApi {
	/**
	 * Makes a client that sends write requests with the write token.
	 *
	 * @param baseUrl - The Forgejo base URL with no trailing slash.
	 * @param token - The write-scoped token.
	 * @param trace - The tracer for `http` events.
	 * @param holdsSecret - True when a text holds a stored or env token. A body that
	 *   does is refused, so no write verb can publish a token, for example through
	 *   a `--body-file` that points at the token store.
	 * @example
	 * const api = new WriteApi("https://git.example.com", token, trace, redact.contains);
	 */
	constructor(
		private readonly baseUrl: string,
		private readonly token: string,
		private readonly trace: Tracer,
		private readonly holdsSecret: (text: string) => boolean,
	) {}

	/**
	 * Checks that a body can be sent: it must hold no stored or env token. A dry
	 * run calls it too, so the plan predicts the same refusal as the real run.
	 *
	 * @param body - The JSON body, if any.
	 * @returns Nothing.
	 * @throws {FgjError} A usage error when the body holds a token.
	 * @example
	 * api.assertSendable({ body: text });
	 */
	assertSendable(body?: unknown): void {
		if (body !== undefined && this.holdsSecret(JSON.stringify(body))) {
			throw tokenInBody();
		}
	}

	/**
	 * Sends one GET request to `/api/v1` with the write token, for the reads
	 * that a write needs first.
	 *
	 * @param path - The path after `/api/v1`.
	 * @param query - Query parameters, if any.
	 * @returns The parsed JSON body.
	 * @throws {FgjError} An auth, not_found, conflict, or api error.
	 * @example
	 * const labels = await api.get<Label[]>("/repos/o/r/labels", { limit: 50, page: 1 });
	 */
	get<T>(path: string, query?: Query): Promise<T> {
		return request<T>(this.baseUrl, this.token, this.trace, "GET", path, query);
	}

	/**
	 * Sends one GET request for a page of a list with the write token, and reads
	 * the total from Forgejo's `X-Total-Count` header.
	 *
	 * @param path - The path after `/api/v1`.
	 * @param query - Query parameters, with `page` and `limit`.
	 * @returns The items of the page, and the number of items in every page.
	 * @throws {FgjError} An auth, not_found, conflict, or api error.
	 * @example
	 * const { items, total } = await api.list<Label>("/repos/o/r/labels", { page: 1, limit: 50 });
	 */
	list<T>(path: string, query: Query): Promise<{ items: T[]; total: number }> {
		return listPage<T>(this.baseUrl, this.token, this.trace, path, query);
	}

	/**
	 * Sends one GET request, and reads Forgejo's `X-Total-Count` header when the
	 * server sends one. For a paged body that is not a plain list, such as the
	 * combined commit status.
	 *
	 * @param path - The path after `/api/v1`.
	 * @param query - Query parameters, if any.
	 * @returns The parsed JSON body, and the total when the header is present.
	 * @throws {FgjError} An auth, not_found, conflict, or api error.
	 * @example
	 * const { data, total } = await api.getCounted<{ statuses: unknown[] }>(path, { page: 1, limit: 50 });
	 */
	getCounted<T>(
		path: string,
		query?: Query,
	): Promise<{ data: T; total?: number }> {
		return countedGet<T>(this.baseUrl, this.token, this.trace, path, query);
	}

	/**
	 * Sends one request to `/api/v1`.
	 *
	 * @param method - The HTTP method.
	 * @param path - The path after `/api/v1`.
	 * @param body - The JSON body, if any.
	 * @returns The parsed JSON body, or `null` for an empty response.
	 * @throws {FgjError} An auth, not_found, conflict, or api error.
	 * @example
	 * await api.send("POST", "/repos/o/r/issues/1/comments", { body: "Done." });
	 */
	send<T>(method: Method, path: string, body?: unknown): Promise<T> {
		try {
			this.assertSendable(body);
		} catch (err) {
			return Promise.reject(err);
		}
		return request<T>(
			this.baseUrl,
			this.token,
			this.trace,
			method,
			path,
			undefined,
			body,
		);
	}

	/**
	 * Uploads one text file as a multipart POST to `/api/v1`. The file is
	 * refused when it holds a stored or env token, as a body is. The name goes
	 * in the `name` query, which Forgejo stores as sent: a multipart file name
	 * with a quote can reach the server in another form, or not at all, so the
	 * part gets a fixed name.
	 *
	 * @param path - The path after `/api/v1`.
	 * @param field - The multipart field name, for example `attachment`.
	 * @param file - The file name to send and its text.
	 * @returns The parsed JSON body.
	 * @throws {FgjError} A usage error for a token in the file, or an auth,
	 *   not_found, conflict, or api error.
	 * @example
	 * await api.upload("/repos/o/r/issues/comments/770/assets", "attachment", { name: "e.md", text });
	 */
	upload<T>(
		path: string,
		field: string,
		file: { name: string; text: string },
	): Promise<T> {
		try {
			this.assertSendable({ text: file.text });
		} catch (err) {
			return Promise.reject(err);
		}
		const form = new FormData();
		form.append(field, new Blob([file.text]), "upload.txt");
		return request<T>(
			this.baseUrl,
			this.token,
			this.trace,
			"POST",
			path,
			{ name: file.name },
			form,
		);
	}
}

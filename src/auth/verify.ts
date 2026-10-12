import { FgjError } from "../core/errors.ts";
import type { Tracer } from "../core/trace.ts";
import type { TokenKind } from "./store.ts";

/** The scopes that `fgj auth` asks for, per token. */
export const SCOPES: Record<TokenKind, string> = {
	read: "read:issue, read:repository, read:user",
	write: "write:issue, write:repository, read:user",
};

async function probe(
	baseUrl: string,
	token: string,
	trace: Tracer,
	method: string,
	path: string,
): Promise<number> {
	const started = performance.now();
	try {
		const res = await fetch(`${baseUrl}/api/v1${path}`, {
			// A followed redirect would turn a POST probe into a GET and misread a scope.
			redirect: "manual",
			method,
			headers: {
				authorization: `token ${token}`,
				"content-type": "application/json",
			},
			...(method === "GET" ? {} : { body: "{}" }),
		});
		await res.arrayBuffer();
		trace.emit({
			ev: "http",
			method,
			path,
			status: res.status,
			ms: Math.round(performance.now() - started),
		});
		return res.status;
	} catch (err) {
		trace.emit({ ev: "http", method, path, error: String(err) });
		throw new FgjError(
			"api",
			`Cannot reach ${baseUrl}: ${String(err)}`,
			"fgj auth status",
		);
	}
}

/**
 * Checks a token's scopes with side-effect-free probes. Forgejo has no endpoint
 * that lists scopes, so every probe targets a repository that does not exist:
 * HTTP 403 means the scope is missing, and 404 means the scope is present.
 *
 * - A read token must read issues and repositories and must not write either.
 * - A write token must write issues and repositories.
 * - Both need `read:user`, to name the token's user.
 *
 * @param baseUrl - The Forgejo base URL.
 * @param token - The token to check.
 * @param kind - `read` or `write`: the role the token will have in fgj.
 * @param trace - The tracer for the probe calls.
 * @param versionHidden - True when the server answered `/version` only with a
 *   sign-in error. A 401 or 403 from `/user` then counts as a token error only
 *   when it carries Forgejo's error shape or, for a 403, one of Forgejo's account
 *   messages (prohibited from signing in, not activated, change your password).
 * @returns The login of the token's user.
 * @throws {FgjError} An auth error that names the exact scope problem, or an api
 *   error when the host may not be Forgejo.
 * @example
 * const { user } = await verifyToken("https://git.example.com", token, "read", trace);
 */
export async function verifyToken(
	baseUrl: string,
	token: string,
	kind: TokenKind,
	trace: Tracer,
	versionHidden = false,
): Promise<{ user: string }> {
	const fail = (message: string) =>
		new FgjError("auth", message, "fgj auth status");
	const me = await fetch(`${baseUrl}/api/v1/user`, {
		redirect: "manual",
		headers: { authorization: `token ${token}` },
	}).catch((err) => {
		throw new FgjError(
			"api",
			`Cannot reach ${baseUrl}: ${String(err)}`,
			"fgj auth status",
		);
	});
	trace.emit({ ev: "http", method: "GET", path: "/user", status: me.status });
	if (me.status === 401 || me.status === 403) {
		const body = (await me.json().catch(() => undefined)) as
			| { message?: unknown; url?: unknown }
			| undefined;
		// Forgejo's token and scope errors carry the swagger URL. Match the suffix
		// only: the url uses the server's ROOT_URL, which can differ from the URL
		// that the human typed.
		const forgejo =
			typeof body?.url === "string" && body.url.endsWith("/api/swagger");
		// Only the first line, with no control or format characters, so a hostile
		// host cannot write terminal escapes or reorder text while fgj asks for a token.
		const reason =
			typeof body?.message === "string"
				? (body.message.split("\n")[0] ?? "")
						.replace(/[\p{Cc}\p{Cf}]/gu, "")
						.slice(0, 200)
				: "";
		if (forgejo && me.status === 401) {
			throw fail(`The ${kind} token is not valid on ${baseUrl} (HTTP 401).`);
		}
		if (forgejo) throw fail(`The ${kind} token lacks read:user.`);
		// A disabled or blocked account gets a 403 with a message and no swagger URL.
		// When the server hid its version, only Forgejo's own account texts count,
		// so fgj never asks for more tokens to send to a host that may not be Forgejo.
		const account = versionHidden
			? /prohibited from signing in|not activated|change your password/i.test(
					reason,
				)
			: reason !== "";
		if (me.status === 403 && account) {
			throw fail(
				`${baseUrl} refused the ${kind} token's account (HTTP 403): ${reason}`,
			);
		}
		if (versionHidden) {
			throw new FgjError(
				"api",
				`${baseUrl} refused GET /api/v1/user (HTTP ${me.status}) without a Forgejo error, and it hid its version, so it may not be Forgejo. Check the URL.`,
				"fgj help auth",
			);
		}
		if (me.status === 401) {
			throw fail(`The ${kind} token is not valid on ${baseUrl} (HTTP 401).`);
		}
		throw fail(`The ${kind} token lacks read:user.`);
	}
	if (!me.ok) {
		throw new FgjError(
			"api",
			`GET /user gave HTTP ${me.status}.`,
			"fgj auth status",
		);
	}
	const user = ((await me.json()) as { login: string }).login;
	const missing = `/repos/${encodeURIComponent(user)}/fgj-scope-probe-${crypto.randomUUID()}`;
	const checks = [
		{
			method: "GET",
			path: `${missing}/issues/1/comments`,
			scope: "read:issue",
			write: false,
		},
		{ method: "GET", path: missing, scope: "read:repository", write: false },
		{
			method: "POST",
			path: `${missing}/issues/1/comments`,
			scope: "write:issue",
			write: true,
		},
		{ method: "PATCH", path: missing, scope: "write:repository", write: true },
		// Only the read token must lack these. Each target cannot exist (id 0, a
		// random name), so every probe answers 403 or 404 and changes nothing.
		...[
			["DELETE", "/user/keys/0", "write:user"],
			[
				"PATCH",
				`/orgs/fgj-scope-probe-${crypto.randomUUID()}`,
				"write:organization",
			],
			[
				"DELETE",
				`/packages/${encodeURIComponent(user)}/generic/fgj-scope-probe-${crypto.randomUUID()}/1`,
				"write:package",
			],
			["PATCH", "/notifications/threads/0", "write:notification"],
			[
				"PATCH",
				`/admin/users/fgj-scope-probe-${crypto.randomUUID()}`,
				"write:admin",
			],
		].map(([method, path, scope]) => ({
			method: method as string,
			path: path as string,
			scope: scope as string,
			write: true,
			readOnly: true,
		})),
	];
	const statuses = await Promise.all(
		checks.map((c) => probe(baseUrl, token, trace, c.method, c.path)),
	);
	checks.forEach((check, i) => {
		const status = statuses[i];
		if (status !== 403 && status !== 404) {
			throw new FgjError(
				"api",
				`The ${check.scope} check gave HTTP ${status}, not 403 or 404.`,
				"fgj auth status",
			);
		}
		const has = status === 404;
		if (!check.write && !has)
			throw fail(`The ${kind} token lacks ${check.scope}.`);
		if (check.write && kind === "read" && has) {
			throw fail(
				`This read token can write (it has ${check.scope} or all). Create a read token with only ${SCOPES.read}.`,
			);
		}
		if (check.write && kind === "write" && !has && !("readOnly" in check)) {
			throw fail(`The write token lacks ${check.scope}.`);
		}
	});
	return { user };
}

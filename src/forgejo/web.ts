import { FgjError } from "../core/errors.ts";
import type { Tracer } from "../core/trace.ts";
import { decodeHtml } from "./board.ts";

/**
 * The web login of a profile: the remember-me cookie that Forgejo set when a
 * human signed in. Forgejo has no API for boards or re-runs, so those verbs use the web pages,
 * and this cookie gets each call a short web session.
 */
export interface WebLogin {
	/** The cookie name. Forgejo's default is `persistent`; `COOKIE_REMEMBER_NAME` changes it. */
	cookie: string;
	value: string;
	/** When Forgejo stops accepting the cookie, as an RFC 3339 time. */
	expires: string;
}

/** One `Set-Cookie` line, reduced to what fgj uses. */
interface SetCookie {
	name: string;
	value: string;
	/** Milliseconds until the cookie expires, or `undefined` for a session cookie. */
	lifetime?: number;
}

/** A cookie that lives this long or longer can be a remember-me cookie. */
const LONG_LIVED_MS = 86_400_000;

/**
 * Reads one `Set-Cookie` header line.
 *
 * @param line - The header value, for example `persistent=abc; Path=/; Max-Age=2678400`.
 * @param now - The current time in milliseconds, for an `Expires` attribute.
 * @returns The name, the value, and the lifetime. A cleared cookie has a lifetime of 0 or less.
 * @example
 * parseSetCookie("persistent=abc; Max-Age=60", 0); // { name: "persistent", value: "abc", lifetime: 60000 }
 */
export function parseSetCookie(line: string, now: number): SetCookie {
	const [pair = "", ...attrs] = line.split(";");
	const at = pair.indexOf("=");
	const name = (at < 0 ? pair : pair.slice(0, at)).trim();
	const value = at < 0 ? "" : pair.slice(at + 1).trim();
	let lifetime: number | undefined;
	for (const attr of attrs) {
		const [key = "", raw = ""] = attr.split("=").map((s) => s.trim());
		if (/^max-age$/i.test(key) && /^-?\d+$/.test(raw)) {
			lifetime = Number(raw) * 1000;
			break;
		}
		if (/^expires$/i.test(key)) {
			const when = Date.parse(attr.slice(attr.indexOf("=") + 1).trim());
			if (!Number.isNaN(when)) lifetime = when - now;
		}
	}
	if (value === "") lifetime = 0;
	return lifetime === undefined ? { name, value } : { name, value, lifetime };
}

/** The cookies of one web session. */
class Jar {
	private readonly cookies = new Map<string, string>();

	constructor(initial: Record<string, string> = {}) {
		for (const [k, v] of Object.entries(initial)) this.cookies.set(k, v);
	}

	/** Keeps each cookie that the response sets, and drops each one that it clears. */
	absorb(res: Response, now: number): SetCookie[] {
		const set = res.headers.getSetCookie().map((l) => parseSetCookie(l, now));
		for (const c of set) {
			if (c.lifetime !== undefined && c.lifetime <= 0)
				this.cookies.delete(c.name);
			else this.cookies.set(c.name, c.value);
		}
		return set;
	}

	header(): string {
		return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
	}

	values(): string[] {
		return [...this.cookies.values()];
	}
}

/** Where a redirect goes, as a path on the Forgejo host, or `null` for another host. */
function redirectPath(baseUrl: string, res: Response): string | null {
	const location = res.headers.get("location");
	if (!location) return null;
	const to = new URL(location, baseUrl);
	return to.origin === new URL(baseUrl).origin ? to.pathname : null;
}

/** A web request body: a form, or JSON. */
export type WebBody = { form: Record<string, string> } | { json: unknown };

/** The web request that fgj sends: no automatic redirects, and a trace line. */
async function send(
	baseUrl: string,
	jar: Jar,
	trace: Tracer,
	method: "GET" | "POST",
	path: string,
	body?: WebBody,
): Promise<Response> {
	const url = `${baseUrl}${path}`;
	// The same guard as the API client: a path that URL parsing changes could
	// leave the repository.
	const pathOnly = path.split("?")[0] as string;
	const built = `${new URL(baseUrl).pathname.replace(/\/$/, "")}${pathOnly}`;
	if (new URL(url).pathname !== built || /%(?:2f|5c)/i.test(pathOnly)) {
		throw new FgjError(
			"usage",
			`URL parsing would change the web path ${path}. fgj does not send it.`,
			"fgj help",
		);
	}
	const started = performance.now();
	let res: Response;
	try {
		res = await fetch(url, {
			method,
			redirect: "manual",
			headers: {
				cookie: jar.header(),
				...(body
					? {
							"content-type":
								"form" in body
									? "application/x-www-form-urlencoded"
									: "application/json",
						}
					: {}),
			},
			...(body
				? {
						body:
							"form" in body
								? new URLSearchParams(body.form).toString()
								: JSON.stringify(body.json),
					}
				: {}),
		});
	} catch (err) {
		trace.emit({ ev: "http", web: true, method, path, error: String(err) });
		throw new FgjError(
			"api",
			`Cannot reach ${baseUrl} (${String(err)})`,
			"fgj auth status",
		);
	}
	trace.emit({
		ev: "http",
		web: true,
		method,
		path,
		status: res.status,
		ms: Math.round(performance.now() - started),
	});
	return res;
}

/** True when the response is a redirect to the sign-in page. */
function toSignIn(baseUrl: string, res: Response): boolean {
	return (
		res.status >= 300 &&
		res.status < 400 &&
		(redirectPath(baseUrl, res) ?? "").endsWith("/user/login")
	);
}

/**
 * Gets a new web session from the remember-me cookie alone. It never sends a
 * live session with it: Forgejo then replaces that session, and every other
 * process that holds it is signed out.
 *
 * @returns The session cookies, or `null` when Forgejo no longer accepts the login.
 */
async function renew(
	baseUrl: string,
	login: Pick<WebLogin, "cookie" | "value">,
	trace: Tracer,
	addSecret: (value: string) => void,
): Promise<Jar | null> {
	const jar = new Jar({ [login.cookie]: login.value });
	const res = await send(baseUrl, jar, trace, "GET", "/user/login");
	await res.body?.cancel();
	// Forgejo shows the sign-in page (200) or sends back to it when it no longer
	// accepts the login. Any other answer is a server problem, not a revoked login.
	if (res.status === 200 || toSignIn(baseUrl, res)) return null;
	if (res.status < 300 || res.status >= 400) {
		throw new FgjError(
			"api",
			`${baseUrl} answered GET /user/login with HTTP ${res.status}.`,
			"fgj auth status",
		);
	}
	const session = new Jar()
		.absorb(res, Date.now())
		.filter((c) => c.name !== login.cookie && (c.lifetime ?? 1) > 0);
	if (session.length === 0) return null;
	const out = new Jar(
		Object.fromEntries(session.map((c) => [c.name, c.value])),
	);
	for (const v of out.values()) addSecret(v);
	return out;
}

/**
 * The Forgejo login of the account that a web session belongs to. The API
 * refuses web sessions, so fgj reads the user name field of the settings page.
 */
async function sessionUser(
	baseUrl: string,
	jar: Jar,
	trace: Tracer,
): Promise<string | null> {
	const res = await send(baseUrl, jar, trace, "GET", "/user/settings");
	if (res.status !== 200) {
		await res.body?.cancel();
		return null;
	}
	let login: string | null = null;
	await new HTMLRewriter()
		.on('input[name="name"][value]', {
			element(e) {
				login ??= decodeHtml(e.getAttribute("value") ?? "") || null;
			},
		})
		.transform(res)
		.text();
	return login;
}

/** What {@link signIn} asks the human for. */
export interface SignInPrompts {
	/** The password. It returns an empty string when the human gives up. */
	password(): Promise<string>;
	/** The TOTP code, asked only when the account has two-factor sign-in. */
	code(): Promise<string>;
}

/**
 * Signs in with remember-me, as the web form does, and finds the remember-me
 * cookie: the one long-lived cookie that gets a new session by itself. It
 * keeps nothing else, and never the password.
 *
 * @param baseUrl - The Forgejo base URL.
 * @param user - The Forgejo login to sign in as.
 * @param ask - Asks the human for the password and, when needed, the TOTP code.
 * @param trace - The tracer for `http` events.
 * @param addSecret - Registers each password, code, and cookie with the redactor.
 * @returns The web login, and the login of the account that it signs in as.
 * @throws {FgjError} An auth error when Forgejo refuses the password or the
 *   code, needs a security key, or sets no remember-me cookie.
 * @example
 * const { login } = await signIn("https://git.example.com", "dm-bot", prompts, trace, redact.add);
 */
export async function signIn(
	baseUrl: string,
	user: string,
	ask: SignInPrompts,
	trace: Tracer,
	addSecret: (value: string) => void,
): Promise<{ login: WebLogin; user: string }> {
	const password = await ask.password();
	if (!password) {
		throw new FgjError("usage", "No password entered.", "fgj help auth");
	}
	addSecret(password);
	const jar = new Jar();
	let res = await send(baseUrl, jar, trace, "POST", "/user/login", {
		form: { user_name: user, password, remember: "on" },
	});
	await res.body?.cancel();
	let set = jar.absorb(res, Date.now());
	let next =
		res.status >= 300 && res.status < 400 ? redirectPath(baseUrl, res) : null;
	if (next === null || next.endsWith("/user/login")) {
		throw new FgjError(
			"auth",
			`${baseUrl} refused the password for ${user}.`,
			"fgj help auth",
		);
	}
	if (next.endsWith("/user/webauthn")) {
		throw new FgjError(
			"auth",
			`${user} signs in with a security key. fgj supports a password with an optional TOTP code only.`,
			"fgj help auth",
		);
	}
	if (next.endsWith("/user/two_factor")) {
		const code = (await ask.code()).trim();
		addSecret(code);
		res = await send(baseUrl, jar, trace, "POST", "/user/two_factor", {
			form: { passcode: code },
		});
		await res.body?.cancel();
		set = jar.absorb(res, Date.now());
		next =
			res.status >= 300 && res.status < 400 ? redirectPath(baseUrl, res) : null;
		if (next === null || next.endsWith("/user/two_factor")) {
			throw new FgjError(
				"auth",
				`${baseUrl} refused the TOTP code for ${user}.`,
				"fgj help auth",
			);
		}
	}
	const now = Date.now();
	for (const c of set) addSecret(c.value);
	for (const c of set) {
		if ((c.lifetime ?? 0) < LONG_LIVED_MS) continue;
		const session = await renew(
			baseUrl,
			{ cookie: c.name, value: c.value },
			trace,
			addSecret,
		);
		if (!session) continue;
		const login = await sessionUser(baseUrl, session, trace);
		if (!login) continue;
		return {
			login: {
				cookie: c.name,
				value: c.value,
				expires: new Date(now + (c.lifetime as number)).toISOString(),
			},
			user: login,
		};
	}
	throw new FgjError(
		"auth",
		`${baseUrl} signed ${user} in but set no remember-me cookie that fgj can use. Check that LOGIN_REMEMBER_DAYS is more than 0.`,
		"fgj help auth",
	);
}

/**
 * Checks a stored web login with one renewal, for `fgj auth status`.
 *
 * @param baseUrl - The Forgejo base URL.
 * @param login - The stored web login.
 * @param trace - The tracer for `http` events.
 * @returns `ok`, `expired` when the stored date passed, `refused`, or `unreachable`.
 * @example
 * await checkWebLogin("https://git.example.com", login, trace); // "ok"
 */
export async function checkWebLogin(
	baseUrl: string,
	login: WebLogin,
	trace: Tracer,
): Promise<"ok" | "expired" | "refused" | "unreachable"> {
	if (Date.parse(login.expires) <= Date.now()) return "expired";
	try {
		return (await renew(baseUrl, login, trace, () => {})) ? "ok" : "refused";
	} catch {
		return "unreachable";
	}
}

/** A web page that fgj read, and the path it came from after redirects. */
export interface WebPage {
	path: string;
	html: string;
}

/**
 * The web client that read verbs get: GET only, with a session from the
 * profile's web login. It renews the session on first use, and once more if
 * Forgejo drops it during the call.
 *
 * @example
 * const page = await new WebReader(baseUrl, login, "qa", trace, redact.add).page("/o/r/projects/4");
 */
export class WebReader {
	protected session: Promise<Jar> | undefined;

	/**
	 * Makes a web page client that signs in with the profile's stored web login.
	 *
	 * @param baseUrl - The Forgejo base URL with no trailing slash.
	 * @param login - The profile's stored web login.
	 * @param profile - The profile name, for the error that asks a human to sign in again.
	 * @param trace - The tracer for `http` events.
	 * @param addSecret - Registers each session cookie with the redactor.
	 * @example
	 * const web = new WebReader("https://git.example.com", login, "qa", trace, redact.add);
	 */
	constructor(
		protected readonly baseUrl: string,
		protected readonly login: WebLogin,
		protected readonly profile: string,
		protected readonly trace: Tracer,
		protected readonly addSecret: (value: string) => void,
	) {}

	protected signInAgain(why: string): FgjError {
		return new FgjError(
			"auth",
			`${why} Verbs with no API endpoint, such as the board verbs, need it. A human must run fgj auth web --profile ${this.profile}.`,
			`fgj auth web --profile ${this.profile}`,
		);
	}

	protected open(): Promise<Jar> {
		this.session ??= (async () => {
			if (Date.parse(this.login.expires) <= Date.now()) {
				throw this.signInAgain(
					`The web login of profile ${this.profile} expired on ${this.login.expires.slice(0, 10)}.`,
				);
			}
			const jar = await renew(
				this.baseUrl,
				this.login,
				this.trace,
				this.addSecret,
			);
			if (!jar) {
				throw this.signInAgain(
					`${this.baseUrl} no longer accepts the web login of profile ${this.profile}: a password change or an admin revoked it.`,
				);
			}
			return jar;
		})();
		return this.session;
	}

	/**
	 * Reads one web page. It follows a redirect only inside the same first two
	 * path parts (`/{owner}/{repo}/`), for example from an issue to its pull
	 * request, and keeps the redirect's query.
	 *
	 * @param path - The path after the base URL, for example `/o/r/projects/4`.
	 * @returns The page and its final path, or `null` when Forgejo answers 404.
	 * @throws {FgjError} An auth error when the web login no longer works, a
	 *   not_found error when Forgejo moved the repository, or an api error for
	 *   any other answer.
	 * @example
	 * const board = await web.page("/o/r/projects/4");
	 */
	async page(path: string): Promise<WebPage | null> {
		const prefix = new URL(this.baseUrl).pathname.replace(/\/$/, "");
		const scope = `/${(path.split("?")[0] as string).split("/").slice(1, 3).join("/")}/`;
		let at = path;
		let renewed = false;
		for (let hop = 0; hop < 4; hop++) {
			const jar = await this.open();
			const res = await send(this.baseUrl, jar, this.trace, "GET", at);
			if (res.status === 200) return { path: at, html: await res.text() };
			await res.body?.cancel();
			if (res.status === 404) return null;
			if (toSignIn(this.baseUrl, res) && !renewed) {
				// The server dropped the session, for example after a restart.
				renewed = true;
				this.session = undefined;
				continue;
			}
			const location = res.headers.get("location");
			const to =
				res.status >= 300 && res.status < 400 && location
					? new URL(location, `${this.baseUrl}/`)
					: null;
			if (to && !to.pathname.endsWith("/user/login")) {
				const inside =
					to.origin === new URL(this.baseUrl).origin &&
					to.pathname.startsWith(`${prefix}/`);
				const rel = inside ? to.pathname.slice(prefix.length) : to.href;
				if (!inside) {
					throw new FgjError(
						"api",
						`${this.baseUrl} redirected GET ${path} outside its base URL, to ${to.origin}${to.pathname}. fgj does not follow it.`,
						"fgj auth status",
					);
				}
				if (!rel.startsWith(scope)) {
					throw new FgjError(
						"not_found",
						`${this.baseUrl} moved ${path} to ${rel}: the repository was renamed or transferred. Use --repo with the new owner/name.`,
						"fgj help",
					);
				}
				at = rel + to.search;
				continue;
			}
			if (toSignIn(this.baseUrl, res)) {
				throw this.signInAgain(
					`${this.baseUrl} signed profile ${this.profile} out during the call.`,
				);
			}
			throw new FgjError(
				"api",
				`${this.baseUrl} answered GET ${at} with HTTP ${res.status}.`,
				"fgj help",
			);
		}
		throw new FgjError(
			"api",
			`${this.baseUrl} redirected GET ${path} too many times.`,
			"fgj help",
		);
	}
}

/**
 * The web client that write verbs get: GET, and POST to the routes that the
 * board and run verbs define. Forgejo 16 checks no CSRF token on these routes;
 * it checks the session and the account's permission.
 *
 * @example
 * await new WebWriter(baseUrl, login, "qa", trace, redact.add).post("/o/r/issues/projects", { form });
 */
export class WebWriter extends WebReader {
	/**
	 * Sends one repository project creation form without retrying the write.
	 *
	 * @param path - The repository route, for example `/o/r/projects/new`.
	 * @param form - The validated title, template_type, card_type, and content fields.
	 * @returns Nothing. The caller must read the saved board before success.
	 * @throws {FgjError} An error for any response except this repository's projects-list 303.
	 * @example
	 * await web.createProject("/o/r/projects/new", {title:"Plan", template_type:"1", card_type:"1", content:""});
	 */
	async createProject(
		path: string,
		form: Record<string, string>,
	): Promise<void> {
		if (!/^\/[^/]+\/[^/]+\/projects\/new$/.test(path))
			throw new FgjError(
				"usage",
				"Project creation needs a repository projects/new route.",
				"fgj help board create",
			);
		const jar = await this.open();
		const res = await send(this.baseUrl, jar, this.trace, "POST", path, {
			form,
		});
		await res.body?.cancel();
		const location = res.headers.get("location");
		const expected = new URL(`${this.baseUrl}${path.slice(0, -4)}`);
		let to: URL | undefined;
		try {
			if (location) to = new URL(location, `${this.baseUrl}${path}`);
		} catch {
			/* An invalid redirect is an uncertain creation result. */
		}
		if (
			res.status >= 300 &&
			res.status < 400 &&
			to?.origin === expected.origin &&
			to.pathname.endsWith("/user/login")
		)
			throw this.signInAgain(
				`${this.baseUrl} signed profile ${this.profile} out during project creation. fgj did not repeat the write.`,
			);
		if (res.status === 303) {
			if (
				to &&
				to.origin === expected.origin &&
				to.pathname === expected.pathname &&
				!to.search &&
				!to.hash &&
				!to.username &&
				!to.password
			)
				return;
		}
		if (res.status === 403)
			throw new FgjError(
				"auth",
				`Profile ${this.profile} has no permission to create a repository project (HTTP 403).`,
				"fgj auth status",
			);
		if (res.status === 404)
			throw new FgjError(
				"not_found",
				"Project creation is unavailable (HTTP 404): check Projects write permission, Projects enabled, and repository access.",
				"fgj help board create",
			);
		if (res.status === 200 || res.status === 400)
			throw new FgjError(
				"conflict",
				"Forgejo refused the project creation form. Check the name, Projects write permission, and repository state. No success is confirmed.",
				"fgj help board create",
			);
		throw new FgjError(
			"api",
			`Project creation is uncertain (HTTP ${res.status}). fgj did not repeat the write. Check the project list before another create.`,
			"fgj help board create",
		);
	}

	/**
	 * Sends one POST and returns Forgejo's answer: `{"ok":true}`, or
	 * `{"redirect": URL}` for a route that names a new page, such as a re-run. A
	 * session that the server dropped is renewed once: the redirect to sign-in
	 * comes before the route runs, so the retry cannot apply the change twice.
	 *
	 * @param path - The path after the base URL, for example `/o/r/projects/4/12/move`.
	 * @param body - A form or a JSON body.
	 * @returns Forgejo's JSON answer.
	 * @throws {FgjError} An auth error for a lost login or a refused permission, a
	 *   conflict error with Forgejo's reason for a 400 that names one, a
	 *   not_found error for a 404, or an api error for any other answer.
	 * @example
	 * await web.post("/o/r/projects/4/12/move", { json: { issues: [] } }); // { ok: true }
	 */
	async post(path: string, body: WebBody): Promise<Record<string, unknown>> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const jar = await this.open();
			const res = await send(this.baseUrl, jar, this.trace, "POST", path, body);
			const text = await res.text();
			const answer = parseAnswer(text);
			if (
				res.status === 200 &&
				(answer?.ok === true || typeof answer?.redirect === "string")
			) {
				return answer as Record<string, unknown>;
			}
			if (toSignIn(this.baseUrl, res)) {
				if (attempt === 0) {
					this.session = undefined;
					continue;
				}
				throw this.signInAgain(
					`${this.baseUrl} signed profile ${this.profile} out during the call.`,
				);
			}
			if (res.status === 403) {
				throw new FgjError(
					"auth",
					`${this.baseUrl} refused POST ${path} (HTTP 403): the account ${this.profile} has no permission for this change.`,
					"fgj auth status",
				);
			}
			if (res.status === 400 && typeof answer?.errorMessage === "string") {
				// Forgejo names why the current state does not allow the change.
				throw new FgjError(
					"conflict",
					`${this.baseUrl} refused POST ${path}: ${answer.errorMessage}`,
					"fgj help",
				);
			}
			if (res.status === 404) {
				throw new FgjError(
					"not_found",
					`${this.baseUrl} answered POST ${path} with HTTP 404.`,
					"fgj help",
				);
			}
			throw new FgjError(
				"api",
				`${this.baseUrl} answered POST ${path} with HTTP ${res.status}.`,
				"fgj help",
			);
		}
		// The second pass returns or throws; this keeps the types exact.
		throw this.signInAgain(
			`${this.baseUrl} signed profile ${this.profile} out during the call.`,
		);
	}
}

/** Forgejo's JSON answer to a POST, or undefined when the body is not a JSON object. */
function parseAnswer(text: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

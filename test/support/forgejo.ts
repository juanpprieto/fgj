import { createHmac } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	isProblem,
	parseLog,
	readServerLog,
} from "../../scripts/forgejo-logs.ts";
import { saveProfile } from "../../src/auth/store.ts";
import { main } from "../../src/core/dispatch.ts";
import { cleanEnv, tempDir } from "./tmp.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const STATE_FILE = join(ROOT, ".forgejo-test", "server.json");
const CLI = join(ROOT, "src", "cli.ts");

/** Connection data that `scripts/forgejo-test-server.ts start` writes. */
export interface TestServer {
	url: string;
	username: string;
	password: string;
	readToken: string;
	writeToken: string;
	/** The server's largest API page; a fixture of `apiPage + 1` items crosses a page. */
	apiPage: number;
}

/** A user name and password for basic auth. */
export interface Login {
	username: string;
	password: string;
}

/** A repository that a test created on the test server. */
export interface FixtureRepo {
	owner: string;
	name: string;
}

/** The result of one `fgj` run, with the evidence to debug it. */
export interface FgjResult {
	argv: string[];
	code: number;
	stdout: string;
	stderr: string;
	/** The `FGJ_TRACE` JSON lines of this run. */
	trace: string;
	/** When the run started, as an RFC 3339 time, for the server log window. */
	startedAt: string;
}

/**
 * Loads the state of the running test server.
 *
 * @returns The URL, the admin login, both tokens, and the API page size.
 * @throws When no server runs, or it is older than its page setting. Start one
 *   with `bun run forgejo:start`.
 * @example
 * const server = await loadServer();
 */
export async function loadServer(): Promise<TestServer> {
	const file = Bun.file(STATE_FILE);
	if (!(await file.exists())) {
		throw new Error(
			"No test Forgejo. Run `bun run forgejo:start` before the tests.",
		);
	}
	const server = (await file.json()) as TestServer;
	// A server from before the page setting has no apiPage: fixtures would be empty.
	if (!Number.isInteger(server.apiPage) || server.apiPage < 1) {
		throw new Error(
			"The test Forgejo is older than its page setting. Run `bun run forgejo:start`.",
		);
	}
	return server;
}

/**
 * Runs a fixture with configured project templates on a separate disposable Forgejo.
 *
 * @param check - The fixture to run against the configured server.
 * @returns Nothing after the fixture server stops.
 * @example
 * await withProjectTemplates(async server => { await createRepo(server); });
 */
export async function withProjectTemplates(
	check: (server: TestServer) => Promise<void>,
): Promise<void> {
	const dir = tempDir("fgj-configured-templates-");
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	const port = listener.port;
	listener.stop();
	const url = `http://127.0.0.1:${port}`;
	const username = "templatefixture";
	const password = crypto.randomUUID();
	const container = `fgj-configured-templates-${crypto.randomUUID()}`;
	let proc: Bun.Subprocess | undefined;
	let startedContainer = false;
	const run = async (argv: string[]) => {
		const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
		// Commands can hold a password. Never include argv or output in errors.
		await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
		]);
		if ((await p.exited) !== 0)
			throw new Error(`${argv[0]} failed for the template fixture`);
	};
	const create = [
		"admin",
		"user",
		"create",
		"--username",
		username,
		"--password",
		password,
		"--email",
		"template@example.invalid",
		"--admin",
		"--must-change-password=false",
	];
	try {
		if (process.platform === "darwin") {
			await run([
				"podman",
				"run",
				"-d",
				"--name",
				container,
				"-p",
				`127.0.0.1:${port}:3000`,
				"-e",
				"INSTALL_LOCK=true",
				"-e",
				"DB_TYPE=sqlite3",
				"-e",
				"DISABLE_SSH=true",
				"-e",
				`ROOT_URL=${url}/`,
				"-e",
				"FORGEJO__project__PROJECT_BOARD_BASIC_KANBAN_TYPE=Ready,Review,Released",
				"-e",
				"FORGEJO__project__PROJECT_BOARD_BUG_TRIAGE_TYPE=Inspect,Repair,Verified",
				"codeberg.org/forgejo/forgejo@sha256:5effb7305584aca479b29fde6f9631a6dbe86ae798ae02eeea33a3666f0c0bf8",
			]);
			startedContainer = true;
		} else {
			// The standard provisioning script downloads and checks this pinned binary first.
			const binary = join(
				ROOT,
				".forgejo-test",
				"bin",
				`forgejo-16.0.5-linux-${process.arch === "arm64" ? "arm64" : "amd64"}`,
			);
			const ini = join(dir, "app.ini");
			await Bun.write(
				ini,
				[
					`WORK_PATH = ${dir}`,
					"RUN_MODE = prod",
					...(process.getuid?.() === 0
						? ["I_AM_BEING_UNSAFE_RUNNING_AS_ROOT = true"]
						: []),
					"[security]",
					"INSTALL_LOCK = true",
					`SECRET_KEY = ${crypto.randomUUID()}`,
					"[database]",
					"DB_TYPE = sqlite3",
					`PATH = ${join(dir, "forgejo.db")}`,
					"[repository]",
					`ROOT = ${join(dir, "repos")}`,
					"[server]",
					"HTTP_ADDR = 127.0.0.1",
					`HTTP_PORT = ${port}`,
					`ROOT_URL = ${url}/`,
					"DISABLE_SSH = true",
					"[project]",
					"PROJECT_BOARD_BASIC_KANBAN_TYPE = Ready,Review,Released",
					"PROJECT_BOARD_BUG_TRIAGE_TYPE = Inspect,Repair,Verified",
				].join("\n"),
			);
			await run([binary, "--config", ini, "migrate"]);
			await run([binary, "--config", ini, ...create]);
			proc = Bun.spawn([binary, "--config", ini, "web"], {
				stdout: "ignore",
				stderr: "ignore",
			});
		}
		let ready = false;
		for (let attempt = 0; attempt < 90; attempt++) {
			try {
				const res = await fetch(`${url}/api/v1/version`);
				await res.body?.cancel();
				if (res.ok) {
					ready = true;
					break;
				}
			} catch {
				/* The fixture is still starting. */
			}
			await Bun.sleep(1000);
		}
		if (!ready) throw new Error("Template fixture did not start in 90 seconds");
		if (startedContainer)
			await run([
				"podman",
				"exec",
				container,
				"forgejo",
				"--config",
				"/var/lib/gitea/custom/conf/app.ini",
				...create,
			]);
		const server = {
			url,
			username,
			password,
			readToken: "",
			writeToken: "",
			apiPage: 5,
		};
		server.readToken = await mintToken(server, server, [
			"read:issue",
			"read:repository",
			"read:user",
		]);
		server.writeToken = await mintToken(server, server, [
			"write:issue",
			"write:repository",
			"read:user",
		]);
		await check(server);
	} finally {
		if (startedContainer) await run(["podman", "rm", "-f", container]);
		if (proc) {
			proc.kill();
			await proc.exited;
		}
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Sends one API request with basic auth, as the admin by default. Use it only
 * for fixtures and read-backs, never to test fgj itself.
 *
 * @param server - The test server from {@link loadServer}.
 * @param path - The API path after `/api/v1`, for example `/user/repos`.
 * @param body - The JSON body. A request with a body uses POST, otherwise GET.
 * @param login - The user to act as. Defaults to the admin.
 * @returns The parsed JSON response.
 * @throws When the server does not answer 2xx.
 * @example
 * const me = await adminApi(server, "/user");
 */
export async function adminApi<T>(
	server: TestServer,
	path: string,
	body?: unknown,
	login: Login = server,
): Promise<T> {
	const res = await fetch(`${server.url}/api/v1${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			authorization: `Basic ${btoa(`${login.username}:${login.password}`)}`,
			"content-type": "application/json",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (!res.ok) {
		throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as T;
}

/**
 * Creates an empty repository with a unique name, owned by the admin.
 *
 * @param server - The test server from {@link loadServer}.
 * @returns The owner and the name of the new repository.
 * @example
 * const repo = await createRepo(server);
 */
export async function createRepo(server: TestServer): Promise<FixtureRepo> {
	const name = `t-${crypto.randomUUID().slice(0, 8)}`;
	await adminApi(server, "/user/repos", { name });
	return { owner: server.username, name };
}

/**
 * Creates an issue in a fixture repository.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - The repository from {@link createRepo}.
 * @param title - The issue title.
 * @param extra - The body, and label ids from {@link createLabel}.
 * @returns The issue number.
 * @example
 * const issue = await createIssue(server, repo, "Decide the output shape");
 */
export async function createIssue(
	server: TestServer,
	repo: FixtureRepo,
	title: string,
	extra: { body?: string; labels?: number[] } = {},
): Promise<number> {
	const issue = await adminApi<{ number: number }>(
		server,
		`/repos/${repo.owner}/${repo.name}/issues`,
		{ title, ...extra },
	);
	return issue.number;
}

/**
 * Creates a label in a fixture repository.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - The repository from {@link createRepo}.
 * @param name - The label name, for example `priority/p0`.
 * @param options - `exclusive` for a scoped label that replaces its siblings,
 *   `archived` for a retired label, and a `description`.
 * @returns The label id, for {@link createIssue}.
 * @example
 * const p0 = await createLabel(server, repo, "priority/p0", { exclusive: true });
 */
export async function createLabel(
	server: TestServer,
	repo: FixtureRepo,
	name: string,
	options: {
		exclusive?: boolean;
		archived?: boolean;
		description?: string;
	} = {},
): Promise<number> {
	const label = await adminApi<{ id: number }>(
		server,
		`/repos/${repo.owner}/${repo.name}/labels`,
		{
			name,
			color: "#00aabb",
			exclusive: options.exclusive ?? false,
			is_archived: options.archived ?? false,
			description: options.description ?? "",
		},
	);
	return label.id;
}

/**
 * Makes one issue depend on another, as the admin.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - The repository of the issue that depends.
 * @param issue - The number of the issue that depends.
 * @param on - The issue it depends on, and its repository when that differs.
 * @returns Nothing.
 * @example
 * await addDependency(server, repo, 5, { number: 3 });
 */
export async function addDependency(
	server: TestServer,
	repo: FixtureRepo,
	issue: number,
	on: { number: number; repo?: FixtureRepo },
): Promise<void> {
	const target = on.repo ?? repo;
	await adminApi(
		server,
		`/repos/${repo.owner}/${repo.name}/issues/${issue}/dependencies`,
		{ owner: target.owner, repo: target.name, index: on.number },
	);
}

/**
 * Opens a pull request in a new repository that has one commit on `main`. A
 * pull request needs a base branch, so {@link createRepo} cannot make one.
 *
 * @param server - The test server from {@link loadServer}.
 * @param title - The pull request title. A `WIP:` prefix makes it a draft.
 * @returns The repository and the pull request number.
 * @example
 * const { repo, number } = await createPull(server);
 */
export async function createPull(
	server: TestServer,
	title = "A pull request",
): Promise<{ repo: FixtureRepo; number: number }> {
	const name = `t-${crypto.randomUUID().slice(0, 8)}`;
	await adminApi(server, "/user/repos", { name, auto_init: true });
	const repo = { owner: server.username, name };
	return { repo, number: await addPull(server, repo, title) };
}

/**
 * Opens one more pull request, from a new branch with one commit, in a
 * repository from {@link createPull}.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - A repository that has a `main` branch.
 * @param title - The pull request title. A `WIP:` prefix makes it a draft.
 * @param body - The pull request body.
 * @returns The pull request number.
 * @example
 * const n = await addPull(server, repo, "WIP: second");
 */
export async function addPull(
	server: TestServer,
	repo: FixtureRepo,
	title: string,
	body = "",
): Promise<number> {
	const base = `/repos/${repo.owner}/${repo.name}`;
	const branch = `b-${crypto.randomUUID().slice(0, 8)}`;
	await adminApi(server, `${base}/branches`, { new_branch_name: branch });
	await adminApi(server, `${base}/contents/${branch}.txt`, {
		content: btoa(branch),
		branch,
		message: branch,
	});
	const pull = await adminApi<{ number: number }>(server, `${base}/pulls`, {
		head: branch,
		base: "main",
		title,
		body,
	});
	return pull.number;
}

/**
 * Adds a comment to an issue as the admin.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - The repository from {@link createRepo}.
 * @param issue - The issue number.
 * @param body - The comment text, in Markdown.
 * @param login - The author. Defaults to the admin.
 * @returns The comment ID.
 * @example
 * const id = await addComment(server, repo, 1, "First comment");
 */
export async function addComment(
	server: TestServer,
	repo: FixtureRepo,
	issue: number,
	body: string,
	login: Login = server,
): Promise<number> {
	const comment = await adminApi<{ id: number }>(
		server,
		`/repos/${repo.owner}/${repo.name}/issues/${issue}/comments`,
		{ body },
		login,
	);
	return comment.id;
}

/**
 * Makes an empty temporary directory. With a repository or an origin URL, the
 * directory is a git work tree with that `origin`. The directory is removed after
 * the test run.
 *
 * @param server - The test server from {@link loadServer}.
 * @param origin - A fixture repository on the test server, or any remote URL,
 *   for example `git@github.com:acme/app.git`. Leave it out for no git.
 * @returns The absolute path of the directory.
 * @example
 * const cwd = await makeWorkDir(server, repo);
 */
export async function makeWorkDir(
	server: TestServer,
	origin?: FixtureRepo | string,
): Promise<string> {
	const dir = tempDir("fgj-test-");
	if (origin) {
		const url =
			typeof origin === "string"
				? origin
				: `${server.url}/${origin.owner}/${origin.name}.git`;
		for (const cmd of [
			["git", "init", "-q"],
			["git", "remote", "add", "origin", url],
		]) {
			const proc = Bun.spawnSync(cmd, { cwd: dir });
			if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed`);
		}
	}
	return dir;
}

/**
 * Runs `fgj` from source, as an agent does, with the test tokens in the env.
 *
 * @param server - The test server from {@link loadServer}.
 * @param args - The argv after `fgj`, for example `["read", "comment", "list", "1"]`.
 * @param cwd - The working directory, usually from {@link makeWorkDir}.
 * @param env - Env values that replace the test defaults, for example a bad token.
 * @returns The exit code, stdout, stderr, and the trace of the run.
 * @example
 * const result = await runFgj(server, ["read", "comment", "list", "1"], cwd);
 */
export async function runFgj(
	server: TestServer,
	args: string[],
	cwd: string,
	env: Record<string, string> = {},
): Promise<FgjResult> {
	const traceFile = join(cwd, `.fgj-trace-${crypto.randomUUID()}.jsonl`);
	const startedAt = new Date().toISOString();
	const proc = Bun.spawn(["bun", CLI, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...cleanEnv(cwd),
			FGJ_URL: server.url,
			FGJ_READ_TOKEN: server.readToken,
			FGJ_WRITE_TOKEN: server.writeToken,
			FGJ_TRACE: traceFile,
			...env,
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const file = Bun.file(traceFile);
	const trace = (await file.exists()) ? await file.text() : "";
	return { argv: args, code, stdout, stderr, trace, startedAt };
}

async function evidence(result: FgjResult, why: string): Promise<string> {
	const problems = parseLog(await readServerLog(result.startedAt))
		.filter(isProblem)
		.map((l) => JSON.stringify(l));
	return [
		`${why}: fgj ${result.argv.join(" ")}`,
		`exit: ${result.code}`,
		`stdout: ${result.stdout.trim() || "(empty)"}`,
		`stderr: ${result.stderr.trim() || "(empty)"}`,
		"trace:",
		result.trace.trim() || "(none)",
		"server problems since the run started:",
		problems.join("\n") || "(none)",
	].join("\n");
}

/**
 * Checks that a run succeeded and returns its parsed stdout. On failure, the
 * error message holds the argv, both streams, the fgj trace, and the server
 * log problems from the same time window.
 *
 * @param result - The result from {@link runFgj}.
 * @returns The parsed JSON from stdout, typed as `T` by the caller.
 * @throws When the exit code is not 0, stderr is not empty, or stdout is not JSON.
 * @example
 * const out = await expectOk<Page>(await runFgj(server, ["read", "comment", "list", "1"], cwd));
 */
export async function expectOk<T = unknown>(result: FgjResult): Promise<T> {
	if (result.code !== 0 || result.stderr !== "") {
		throw new Error(await evidence(result, "fgj failed"));
	}
	try {
		return JSON.parse(result.stdout) as T;
	} catch {
		throw new Error(await evidence(result, "stdout is not JSON"));
	}
}

/**
 * Checks that a run failed with the expected error code, and returns the error.
 * On a mismatch, the message holds the same evidence as {@link expectOk}.
 *
 * @param result - The result from {@link runFgj}.
 * @param code - The expected `error.code`, for example `not_found`.
 * @param exit - The expected exit code.
 * @returns The parsed `error` object from stderr.
 * @throws When the run succeeded, or failed with a different code or exit code.
 * @example
 * const err = await expectError(result, "usage", 2);
 */
export async function expectError(
	result: FgjResult,
	code: string,
	exit: number,
): Promise<{ code: string; message: string; hint: string }> {
	let parsed: { error?: { code: string; message: string; hint: string } } = {};
	try {
		parsed = JSON.parse(result.stderr);
	} catch {
		// Not JSON: the check below reports it with the evidence.
	}
	if (result.code !== exit || parsed.error?.code !== code || result.stdout) {
		throw new Error(
			await evidence(result, `expected error ${code} with exit ${exit}`),
		);
	}
	return parsed.error;
}

/**
 * Creates a second, non-admin user, for tests that need another author.
 *
 * @param server - The test server from {@link loadServer}.
 * @returns The new user's login.
 * @example
 * const bob = await createUser(server);
 */
export async function createUser(server: TestServer): Promise<Login> {
	const username = `u-${crypto.randomUUID().slice(0, 8)}`;
	const password = `pw-${crypto.randomUUID()}`;
	await adminApi(server, "/admin/users", {
		username,
		password,
		email: `${username}@example.invalid`,
		must_change_password: false,
	});
	return { username, password };
}

/**
 * Reads every comment on an issue through the admin API, to check what fgj wrote.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - The repository from {@link createRepo}.
 * @param issue - The issue number.
 * @returns The comments, oldest first, with id, author, and body.
 * @example
 * const comments = await readComments(server, repo, 1);
 */
export async function readComments(
	server: TestServer,
	repo: FixtureRepo,
	issue: number,
): Promise<{ id: number; author: string; body: string }[]> {
	const raw = await adminApi<
		{ id: number; user: { login: string }; body: string }[]
	>(server, `/repos/${repo.owner}/${repo.name}/issues/${issue}/comments`);
	return raw.map((c) => ({ id: c.id, author: c.user.login, body: c.body }));
}

/**
 * Lists the HTTP calls in a run's trace, as `METHOD path` strings.
 *
 * @param result - The result from {@link runFgj}.
 * @returns One entry per `http` trace event, in order.
 * @example
 * expect(httpCalls(result)).toEqual([]); // no request was sent
 */
export function httpCalls(result: Pick<FgjResult, "trace">): string[] {
	return result.trace
		.split("\n")
		.filter(Boolean)
		.map(
			(line) =>
				JSON.parse(line) as { ev: string; method?: string; path?: string },
		)
		.filter((e) => e.ev === "http")
		.map((e) => `${e.method} ${e.path}`);
}

/**
 * Checks that a run sent at least one request and only GET requests. An empty
 * trace fails, so a broken trace cannot hide a write.
 *
 * @param result - The result from {@link runFgj}.
 * @returns True when the trace holds one or more calls, all GET.
 * @example
 * expect(onlyGets(result)).toBe(true); // it read, and it wrote nothing
 */
export function onlyGets(result: Pick<FgjResult, "trace">): boolean {
	const calls = httpCalls(result);
	return calls.length > 0 && calls.every((c) => c.startsWith("GET"));
}

/**
 * Creates an access token for a user through basic auth, for scope tests.
 *
 * @param server - The test server from {@link loadServer}.
 * @param login - The token owner. Use the admin or a user from {@link createUser}.
 * @param scopes - Forgejo scope names, for example `["read:user"]`.
 * @returns The token.
 * @example
 * const token = await mintToken(server, server, ["read:user"]);
 */
export async function mintToken(
	server: TestServer,
	login: Login,
	scopes: string[],
): Promise<string> {
	const created = await adminApi<{ sha1: string }>(
		server,
		`/users/${login.username}/tokens`,
		{ name: `t-${crypto.randomUUID().slice(0, 8)}`, scopes },
		login,
	);
	return created.sha1;
}

/**
 * Deletes a user as the admin. Forgejo keeps the user's comments and shows them
 * as the Ghost user.
 *
 * @param server - The test server from {@link loadServer}.
 * @param username - The user to delete. Use a user from {@link createUser}.
 * @returns Nothing.
 * @throws When the server does not answer 2xx.
 * @example
 * await deleteUser(server, carol.username);
 */
export async function deleteUser(
	server: TestServer,
	username: string,
): Promise<void> {
	const res = await fetch(`${server.url}/api/v1/admin/users/${username}`, {
		method: "DELETE",
		headers: {
			authorization: `Basic ${btoa(`${server.username}:${server.password}`)}`,
		},
	});
	if (!res.ok) {
		throw new Error(
			`delete ${username}: HTTP ${res.status} ${await res.text()}`,
		);
	}
}

/** A web session cookie header for fixtures, per login. */
const webCookies = new Map<string, Promise<string>>();

/**
 * Signs in to the web UI as a user, for board fixtures: Forgejo has no project
 * API. Use it only to set up and read back, never to test fgj itself.
 */
function fixtureCookie(server: TestServer, login: Login): Promise<string> {
	let cookie = webCookies.get(login.username);
	if (!cookie) {
		cookie = (async () => {
			const res = await fetch(`${server.url}/user/login`, {
				method: "POST",
				redirect: "manual",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					user_name: login.username,
					password: login.password,
				}).toString(),
			});
			if (res.status !== 303) {
				throw new Error(`web sign-in of ${login.username}: HTTP ${res.status}`);
			}
			// Forgejo sets `session` twice: the old id, then the new one. Keep the last.
			const jar = new Map<string, string>();
			for (const line of res.headers.getSetCookie()) {
				const pair = line.split(";")[0] as string;
				const at = pair.indexOf("=");
				jar.set(pair.slice(0, at), pair.slice(at + 1));
			}
			return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
		})();
		webCookies.set(login.username, cookie);
	}
	return cookie;
}

/**
 * Sends one web request with a fixture session, as the admin by default.
 *
 * @param server - The test server from {@link loadServer}.
 * @param path - The path after the base URL, for example `/o/r/projects`.
 * @param body - A form (an object of strings) or a JSON body for a POST. None sends a GET.
 * @param login - The user to act as. Defaults to the admin.
 * @returns The response text.
 * @throws When the server answers 4xx or 5xx.
 * @example
 * const html = await adminWeb(server, `/${repo.owner}/${repo.name}/projects`);
 */
export async function adminWeb(
	server: TestServer,
	path: string,
	body?: { form: Record<string, string> } | { json: unknown },
	login: Login = server,
): Promise<string> {
	const headers: Record<string, string> = {
		cookie: await fixtureCookie(server, login),
	};
	let payload: string | undefined;
	if (body && "form" in body) {
		headers["content-type"] = "application/x-www-form-urlencoded";
		payload = new URLSearchParams(body.form).toString();
	} else if (body) {
		headers["content-type"] = "application/json";
		payload = JSON.stringify(body.json);
	}
	const res = await fetch(`${server.url}${path}`, {
		method: body ? "POST" : "GET",
		redirect: "manual",
		headers,
		...(payload === undefined ? {} : { body: payload }),
	});
	const text = await res.text();
	if (res.status >= 400) throw new Error(`${path}: HTTP ${res.status}`);
	if (res.headers.get("location")?.endsWith("/user/login")) {
		throw new Error(`${path}: the fixture web session is signed out`);
	}
	return text;
}

/**
 * Creates a project with the basic kanban columns (Backlog, To Do, In
 * Progress, Done) in a fixture repository.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - The repository from {@link createRepo}.
 * @param title - The project title. It must be unique in the repository.
 * @returns The project number, and the id of each column by name.
 * @example
 * const alpha = await createProject(server, repo, "Alpha board");
 */
export async function createProject(
	server: TestServer,
	repo: FixtureRepo,
	title: string,
): Promise<{ number: number; columns: Record<string, number> }> {
	const base = `/${repo.owner}/${repo.name}/projects`;
	await adminWeb(server, `${base}/new`, {
		form: { title, template_type: "1", card_type: "1", content: "" },
	});
	const list = await adminWeb(
		server,
		`${base}?q=${encodeURIComponent(title)}&state=open`,
	);
	// The page writes & as &amp;.
	const escaped = title
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replaceAll("&", "&amp;");
	const number = Number(
		new RegExp(`${base}/(\\d+)">${escaped}</a>`).exec(list)?.[1],
	);
	if (!number) throw new Error(`project ${title} not found after create`);
	const board = await adminWeb(server, `${base}/${number}`);
	const columns: Record<string, number> = {};
	for (const m of board.matchAll(
		/data-id="(\d+)"[\s\S]*?project-column-title-label[^>]*>([^<]*)</g,
	)) {
		columns[(m[2] as string).trim()] = Number(m[1]);
	}
	return { number, columns };
}

/** The internal ids of issues, which the project routes take. */
async function issueIds(
	server: TestServer,
	repo: FixtureRepo,
	issues: number[],
): Promise<number[]> {
	return Promise.all(
		issues.map(
			async (n) =>
				(
					await adminApi<{ id: number }>(
						server,
						`/repos/${repo.owner}/${repo.name}/issues/${n}`,
					)
				).id,
		),
	);
}

/**
 * Adds issues to a project, as the issue sidebar does. They land in the
 * default column, Backlog.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - The repository of the issues and the project.
 * @param project - The project number from {@link createProject}.
 * @param issues - The issue numbers.
 * @returns Nothing.
 * @example
 * await addToProject(server, repo, alpha.number, [1, 2]);
 */
export async function addToProject(
	server: TestServer,
	repo: FixtureRepo,
	project: number,
	issues: number[],
): Promise<void> {
	const ids = await issueIds(server, repo, issues);
	await adminWeb(server, `/${repo.owner}/${repo.name}/issues/projects`, {
		form: { issue_ids: ids.join(","), id: String(project) },
	});
}

/**
 * Moves cards to a column, as a drag on the board does.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - The repository of the issues and the project.
 * @param project - The project number.
 * @param column - The column id from {@link createProject}.
 * @param issues - The issue numbers, in the order they take in the column.
 * @returns Nothing.
 * @example
 * await moveCards(server, repo, alpha.number, alpha.columns["To Do"], [2]);
 */
export async function moveCards(
	server: TestServer,
	repo: FixtureRepo,
	project: number,
	column: number | undefined,
	issues: number[],
): Promise<void> {
	if (column === undefined) throw new Error("no such column");
	const ids = await issueIds(server, repo, issues);
	await adminWeb(
		server,
		`/${repo.owner}/${repo.name}/projects/${project}/${column}/move`,
		{ json: { issues: ids.map((issueID, sorting) => ({ issueID, sorting })) } },
	);
}

/**
 * Makes a project on the admin's own account, not on a repository, with a
 * unique title, and returns its number. Delete it with
 * {@link deleteOwnerProject}: owner boards outlive their test, and `board card`
 * reads every one of them. When the helper fails after the create, the project
 * stays; that happens only when Forgejo's page markup changes.
 *
 * @param server - The test server from {@link loadServer}.
 * @param title - The start of the title; the helper adds a unique suffix.
 * @returns The project number and its full title.
 * @example
 * const { id, title } = await createOwnerProject(server, "Owner plan");
 */
export async function createOwnerProject(
	server: TestServer,
	title: string,
): Promise<{ id: number; title: string }> {
	const unique = `${title} ${crypto.randomUUID().slice(0, 6)}`;
	await adminWeb(server, `/${server.username}/-/projects/new`, {
		form: { title: unique, template_type: "1", card_type: "1", content: "" },
	});
	const list = await adminWeb(
		server,
		`/${server.username}/-/projects?q=${encodeURIComponent(unique)}`,
	);
	const id = Number(
		new RegExp(`/${server.username}/-/projects/(\\d+)">${unique}<`).exec(
			list,
		)?.[1],
	);
	if (!(id > 0)) throw new Error(`The owner project ${unique} was not made.`);
	return { id, title: unique };
}

/**
 * Deletes a project on the admin's own account, so the test server does not
 * keep it.
 *
 * @param server - The test server from {@link loadServer}.
 * @param id - The project number from {@link createOwnerProject}.
 * @returns Nothing.
 * @example
 * await deleteOwnerProject(server, id);
 */
export async function deleteOwnerProject(
	server: TestServer,
	id: number,
): Promise<void> {
	await adminWeb(server, `/${server.username}/-/projects/${id}/delete`, {
		form: {},
	});
}

/**
 * Closes a project.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - The repository of the project.
 * @param project - The project number.
 * @returns Nothing.
 * @example
 * await closeProject(server, repo, beta.number);
 */
export async function closeProject(
	server: TestServer,
	repo: FixtureRepo,
	project: number,
): Promise<void> {
	await adminWeb(
		server,
		`/${repo.owner}/${repo.name}/projects/${project}/close`,
		{ form: {} },
	);
}

/**
 * Makes a work dir's profile, with tokens and a web login, through the real
 * `fgj auth web` flow at a simulated terminal. `runFgj` then acts as it when
 * `FGJ_PROFILE` names it.
 *
 * @param server - The test server from {@link loadServer}.
 * @param cwd - The work dir from {@link makeWorkDir}. It is the fgj HOME.
 * @param options - The profile name (default `t`), the login (default the
 *   admin), its tokens, and `web: false` for a profile with no web login.
 * @returns The fgj output of `fgj auth web`, or null without a web login.
 * @throws When `fgj auth web` fails.
 * @example
 * await webProfile(server, cwd);
 * await runFgj(server, ["read", "board", "list"], cwd, { FGJ_PROFILE: "t" });
 */
export async function webProfile(
	server: TestServer,
	cwd: string,
	options: {
		name?: string;
		login?: Login;
		tokens?: { read: string; write: string };
		web?: boolean;
		code?: () => string;
	} = {},
): Promise<Record<string, unknown> | null> {
	const name = options.name ?? "t";
	const login = options.login ?? server;
	const tokens = options.tokens ?? {
		read: server.readToken,
		write: server.writeToken,
	};
	const env = { HOME: cwd };
	await saveProfile(env, name, {
		host: server.url,
		user: login.username,
		...tokens,
	});
	if (options.web === false) return null;
	let out = "";
	let err = "";
	const code = await main(["auth", "web", "--profile", name], {
		cwd,
		env,
		stdout: (t) => {
			out += t;
		},
		stderr: (t) => {
			err += t;
		},
		prompt: async (question) =>
			question.startsWith("TOTP") ? (options.code?.() ?? "") : login.password,
	});
	if (code !== 0) throw new Error(`fgj auth web: exit ${code} ${err}`);
	return JSON.parse(out) as Record<string, unknown>;
}

/**
 * Computes the current TOTP code (RFC 6238: SHA-1, 6 digits, 30 s steps).
 *
 * @param secret - The base32 secret from {@link enrollTotp}.
 * @param now - The time in milliseconds.
 * @returns The 6-digit code.
 * @example
 * totpCode(secret); // "492039"
 */
export function totpCode(secret: string, now = Date.now()): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = "";
	for (const ch of secret.replace(/=+$/, "").toUpperCase()) {
		bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
	}
	const key = new Uint8Array(Math.floor(bits.length / 8));
	for (let i = 0; i < key.length; i++) {
		key[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
	}
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
	const mac = createHmac("sha1", key).update(counter).digest();
	const offset = (mac[mac.length - 1] as number) & 0xf;
	const value = mac.readUInt32BE(offset) & 0x7fffffff;
	return String(value % 1_000_000).padStart(6, "0");
}

/**
 * Turns on TOTP two-factor sign-in for a user, through the web settings.
 *
 * @param server - The test server from {@link loadServer}.
 * @param login - A user from {@link createUser}.
 * @returns The base32 secret, for {@link totpCode}.
 * @example
 * const secret = await enrollTotp(server, carol);
 */
export async function enrollTotp(
	server: TestServer,
	login: Login,
): Promise<string> {
	const path = "/user/settings/security/two_factor/enroll";
	const page = await adminWeb(server, path, undefined, login);
	const secret = /enter the secret: ([A-Z2-7]+)/.exec(page)?.[1];
	if (!secret) throw new Error("no TOTP secret on the enroll page");
	await adminWeb(server, path, { form: { passcode: totpCode(secret) } }, login);
	return secret;
}

/** A run on the test server, as the fixtures read it back. */
export interface FixtureRun {
	id: number;
	number: number;
	sha: string;
	event: string;
}

/**
 * Pushes a workflow file to a branch. Forgejo creates a run and its jobs for
 * each matching event even with no runner, so the runs stay `waiting` and
 * their jobs have no log.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - A repository with a `main` branch, from {@link createPull} or `auto_init`.
 * @param yaml - The workflow text.
 * @param branch - The branch to commit to.
 * @returns Nothing.
 * @example
 * await pushWorkflow(server, repo, "on: [push]\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: exit 1\n");
 */
export async function pushWorkflow(
	server: TestServer,
	repo: FixtureRepo,
	yaml: string,
	branch = "main",
): Promise<void> {
	await adminApi(
		server,
		`/repos/${repo.owner}/${repo.name}/contents/.forgejo/workflows/ci-${crypto.randomUUID().slice(0, 6)}.yml`,
		{ content: btoa(yaml), message: "ci", branch },
	);
}

/**
 * Waits until a repository has at least `count` Actions runs, then returns
 * them, newest first.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - The repository.
 * @param count - The number of runs to wait for.
 * @returns The runs, with the API id and the web run number.
 * @throws When the runs do not appear within 10 seconds.
 * @example
 * const [run] = await waitForRuns(server, repo, 1);
 */
export async function waitForRuns(
	server: TestServer,
	repo: FixtureRepo,
	count: number,
): Promise<FixtureRun[]> {
	for (let i = 0; i < 40; i++) {
		const out = await adminApi<{
			workflow_runs:
				| {
						id: number;
						index_in_repo: number;
						commit_sha: string;
						event: string;
				  }[]
				| null;
		}>(
			server,
			`/repos/${repo.owner}/${repo.name}/actions/runs?page=1&limit=50`,
		);
		const runs = out.workflow_runs ?? [];
		if (runs.length >= count) {
			return runs.map((r) => ({
				id: r.id,
				number: r.index_in_repo,
				sha: r.commit_sha,
				event: r.event,
			}));
		}
		await Bun.sleep(250);
	}
	throw new Error(`${repo.owner}/${repo.name} never showed ${count} runs`);
}

/**
 * Sends one PATCH or PUT request with basic auth as the admin, for fixtures
 * such as a closed PR, a repository setting, or a changed file.
 *
 * @param server - The test server from {@link loadServer}.
 * @param method - `PATCH` or `PUT`.
 * @param path - The API path after `/api/v1`.
 * @param body - The JSON body.
 * @returns The parsed JSON response.
 * @throws When the server does not answer 2xx.
 * @example
 * await adminSend(server, "PATCH", `/repos/o/r/pulls/1`, { state: "closed" });
 */
export async function adminSend<T = unknown>(
	server: TestServer,
	method: "PATCH" | "PUT",
	path: string,
	body: unknown,
): Promise<T> {
	const res = await fetch(`${server.url}/api/v1${path}`, {
		method,
		headers: {
			authorization: `Basic ${btoa(`${server.username}:${server.password}`)}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
	}
	return (await res.json()) as T;
}

/**
 * Creates a branch from `main` with one new file on it.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - A repository with a `main` branch.
 * @param branch - The branch name; it may hold `/`.
 * @param file - The file to add, and its text. Defaults to a unique file.
 * @returns The SHA of the branch's commit.
 * @example
 * const sha = await pushBranch(server, repo, "feat/login");
 */
export async function pushBranch(
	server: TestServer,
	repo: FixtureRepo,
	branch: string,
	file = { path: `${crypto.randomUUID().slice(0, 8)}.txt`, text: branch },
): Promise<string> {
	const base = `/repos/${repo.owner}/${repo.name}`;
	await adminApi(server, `${base}/branches`, { new_branch_name: branch });
	const made = await adminApi<{ commit: { sha: string } }>(
		server,
		`${base}/contents/${file.path}`,
		{ content: btoa(file.text), branch, message: file.path },
	);
	return made.commit.sha;
}

/**
 * Checks out a server branch in a work dir from {@link makeWorkDir}, as a
 * clone that pushed it would have it.
 *
 * @param server - The test server from {@link loadServer}.
 * @param dir - The work dir, with `origin` set to the repository.
 * @param branch - The branch to fetch and check out.
 * @returns Nothing.
 * @throws When git fails.
 * @example
 * await checkoutBranch(server, cwd, "feat/login");
 */
export async function checkoutBranch(
	server: TestServer,
	dir: string,
	branch: string,
): Promise<void> {
	const auth = `Authorization: Basic ${btoa(`${server.username}:${server.password}`)}`;
	for (const cmd of [
		["git", "-c", `http.extraHeader=${auth}`, "fetch", "-q", "origin", branch],
		["git", "checkout", "-q", "-b", branch, "FETCH_HEAD"],
	]) {
		const proc = Bun.spawnSync(cmd, { cwd: dir, env: cleanEnv(dir) });
		if (proc.exitCode !== 0) {
			throw new Error(`${cmd.slice(-3).join(" ")}: ${proc.stderr.toString()}`);
		}
	}
}

/**
 * Waits until Forgejo has checked that a pull request can merge.
 *
 * @param server - The test server from {@link loadServer}.
 * @param repo - The repository.
 * @param pr - The PR number.
 * @param mergeable - The state to wait for.
 * @returns Nothing.
 * @throws When the state does not hold within 15 seconds.
 * @example
 * await waitMergeable(server, repo, 3, false);
 */
export async function waitMergeable(
	server: TestServer,
	repo: FixtureRepo,
	pr: number,
	mergeable = true,
): Promise<void> {
	// A push to the base starts a new check after a first answer, so the state
	// must hold for 3 reads in a row.
	let held = 0;
	for (let i = 0; i < 60; i++) {
		const pull = await adminApi<{ mergeable: boolean }>(
			server,
			`/repos/${repo.owner}/${repo.name}/pulls/${pr}`,
		);
		held = pull.mergeable === mergeable ? held + 1 : 0;
		if (held === 3) return;
		await Bun.sleep(250);
	}
	throw new Error(`PR ${pr} never showed mergeable ${mergeable}`);
}

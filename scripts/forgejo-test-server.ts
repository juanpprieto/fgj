#!/usr/bin/env bun
/**
 * Starts and stops a disposable Forgejo 16.0.5 with SQLite for real-server tests.
 *
 * - macOS: the pinned rootless image through Podman (no darwin binary exists).
 * - Linux: the pinned release binary, checked against its sha256.
 *
 * `start` writes `.forgejo-test/server.json` (mode 0600) with the URL, the admin
 * login, a read-scoped token, and a write-scoped token. It prints only the URL and
 * the state path, never a secret.
 *
 * Usage: bun scripts/forgejo-test-server.ts <start|stop|status>
 * Env: FGJ_FORGEJO_PORT (default 3917), FGJ_FORGEJO_MODE (podman|binary).
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { containerName } from "./forgejo-logs.ts";

const VERSION = "16.0.5";
const IMAGE =
	"codeberg.org/forgejo/forgejo@sha256:5effb7305584aca479b29fde6f9631a6dbe86ae798ae02eeea33a3666f0c0bf8";
const BINARY_SHA256: Record<string, string> = {
	amd64: "2c548bf1bfa09a441a3a674b1dd4959d77576816ad50534c23496908a3ea5a19",
	arm64: "bd5a6831637ea21eff405e8e0f655ce4ddeb54054bff3d7b37fd50141d176ce1",
};

const CONTAINER = containerName(process.env.FGJ_FORGEJO_PORT ?? "3917");
/** The name before it carried the port; `start` removes it once, as it holds port 3917. */
const LEGACY_CONTAINER = "fgj-forgejo-test";
// Change this when the server config changes, so `start` replaces an old server.
/**
 * The test server's largest API page. A small page lets a test cross a page
 * boundary with a few items, not 51; fgj never assumes that the server pages at 50.
 */
const API_PAGE = 5;
const CONFIG_ID = "info-log-2-port-name-signin-view-page-5-wal";
const CONTAINER_APP_INI = "/var/lib/gitea/custom/conf/app.ini";
const ADMIN_USER = "fgjtest";
const READ_SCOPES = ["read:issue", "read:repository", "read:user"];
const WRITE_SCOPES = ["write:issue", "write:repository", "read:user"];

const ROOT = resolve(import.meta.dir, "..");
const WORK_DIR = join(ROOT, ".forgejo-test");
const STATE_FILE = join(WORK_DIR, "server.json");
const PORT = Number(process.env.FGJ_FORGEJO_PORT ?? "3917");
const URL_BASE = `http://127.0.0.1:${PORT}`;

type Mode = "podman" | "binary";

interface ServerState {
	version: string;
	config: string;
	mode: Mode;
	url: string;
	username: string;
	password: string;
	readToken: string;
	writeToken: string;
	/** The largest API page, so tests can build "one page plus one" fixtures. */
	apiPage: number;
	pid?: number;
}

function pickMode(): Mode {
	const forced = process.env.FGJ_FORGEJO_MODE;
	if (forced === "podman" || forced === "binary") return forced;
	return process.platform === "linux" ? "binary" : "podman";
}

async function run(
	cmd: string[],
	options: { quiet?: boolean } = {},
): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		// Print the command name only: argv can hold the admin password.
		throw new Error(
			`${cmd[0]} ${cmd[1] ?? ""} exited ${code}: ${options.quiet ? "" : err.trim()}`,
		);
	}
	return out.trim();
}

async function readState(): Promise<ServerState | null> {
	const file = Bun.file(STATE_FILE);
	return (await file.exists()) ? ((await file.json()) as ServerState) : null;
}

async function writeState(state: ServerState): Promise<void> {
	await mkdir(WORK_DIR, { recursive: true });
	await Bun.write(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
	await chmod(STATE_FILE, 0o600);
}

// The server needs sign-in for every API call, as private Forgejo hosts often
// do (REQUIRE_SIGNIN_VIEW), so a ready server answers this call with 403.
async function versionOk(): Promise<boolean> {
	try {
		const res = await fetch(`${URL_BASE}/api/v1/version`);
		return res.ok || res.status === 403;
	} catch {
		return false;
	}
}

async function waitForServer(timeoutMs = 90_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await versionOk()) return;
		await Bun.sleep(1000);
	}
	throw new Error(
		`Forgejo did not answer ${URL_BASE}/api/v1/version in ${timeoutMs} ms`,
	);
}

async function tokenWorks(token: string): Promise<boolean> {
	const res = await fetch(`${URL_BASE}/api/v1/user`, {
		headers: { authorization: `token ${token}` },
	});
	return res.ok;
}

function randomSecret(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString(
		"base64url",
	);
}

async function createToken(
	password: string,
	name: string,
	scopes: string[],
): Promise<string> {
	const res = await fetch(`${URL_BASE}/api/v1/users/${ADMIN_USER}/tokens`, {
		method: "POST",
		headers: {
			authorization: `Basic ${btoa(`${ADMIN_USER}:${password}`)}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ name, scopes }),
	});
	if (!res.ok)
		throw new Error(`token ${name}: HTTP ${res.status} ${await res.text()}`);
	const body = (await res.json()) as { sha1: string };
	return body.sha1;
}

function adminCreateArgs(password: string): string[] {
	return [
		"admin",
		"user",
		"create",
		"--username",
		ADMIN_USER,
		"--password",
		password,
		"--email",
		`${ADMIN_USER}@example.invalid`,
		"--admin",
		"--must-change-password=false",
	];
}

async function startPodman(password: string): Promise<void> {
	await run(["podman", "rm", "-f", "--ignore", CONTAINER]);
	if (PORT === 3917)
		await run(["podman", "rm", "-f", "--ignore", LEGACY_CONTAINER]);
	await run([
		"podman",
		"run",
		"-d",
		"--name",
		CONTAINER,
		"-p",
		`127.0.0.1:${PORT}:3000`,
		"-e",
		"INSTALL_LOCK=true",
		"-e",
		"DB_TYPE=sqlite3",
		"-e",
		// Readers do not wait for the one writer, so parallel test files do not queue.
		"FORGEJO__database__SQLITE_JOURNAL_MODE=WAL",
		"-e",
		"DISABLE_SSH=true",
		"-e",
		"DISABLE_REGISTRATION=true",
		"-e",
		`ROOT_URL=${URL_BASE}/`,
		"-e",
		"FORGEJO__mailer__ENABLED=false",
		"-e",
		"FORGEJO__log__LEVEL=Info",
		"-e",
		"FORGEJO__service__REQUIRE_SIGNIN_VIEW=true",
		"-e",
		`FORGEJO__api__MAX_RESPONSE_ITEMS=${API_PAGE}`,
		"-e",
		`FORGEJO__api__DEFAULT_PAGING_NUM=${API_PAGE}`,
		IMAGE,
	]);
	try {
		await waitForServer();
		await run(
			[
				"podman",
				"exec",
				CONTAINER,
				"forgejo",
				"--config",
				CONTAINER_APP_INI,
				...adminCreateArgs(password),
			],
			{ quiet: true },
		);
	} catch (error) {
		await run(["podman", "rm", "-f", "--ignore", CONTAINER]);
		throw error;
	}
}

function binaryArch(): string {
	if (process.arch === "x64") return "amd64";
	if (process.arch === "arm64") return "arm64";
	throw new Error(`no Forgejo binary for arch ${process.arch}`);
}

async function fetchBinary(): Promise<string> {
	const arch = binaryArch();
	const name = `forgejo-${VERSION}-linux-${arch}`;
	const path = join(WORK_DIR, "bin", name);
	if (!(await Bun.file(path).exists())) {
		const url = `https://codeberg.org/forgejo/forgejo/releases/download/v${VERSION}/${name}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
		await mkdir(join(WORK_DIR, "bin"), { recursive: true });
		await Bun.write(path, res);
	}
	// A fresh handle: one made before the download still sees the old, empty size.
	const hash = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(path).arrayBuffer())
		.digest("hex");
	if (hash !== BINARY_SHA256[arch]) {
		await rm(path);
		throw new Error(`sha256 mismatch for ${name}: got ${hash}`);
	}
	await chmod(path, 0o755);
	return path;
}

async function startBinary(password: string): Promise<number> {
	const binary = await fetchBinary();
	const data = join(WORK_DIR, "data");
	await rm(data, { recursive: true, force: true });
	await mkdir(data, { recursive: true });
	const appIni = join(WORK_DIR, "app.ini");
	await Bun.write(
		appIni,
		[
			`WORK_PATH = ${data}`,
			"RUN_MODE = prod",
			// CI job containers run as root, and Forgejo refuses root by default.
			// This server is disposable and bound to 127.0.0.1.
			...(process.getuid?.() === 0
				? ["I_AM_BEING_UNSAFE_RUNNING_AS_ROOT = true"]
				: []),
			"[security]",
			"INSTALL_LOCK = true",
			`SECRET_KEY = ${randomSecret()}`,
			"[database]",
			"DB_TYPE = sqlite3",
			`PATH = ${join(data, "forgejo.db")}`,
			// Readers do not wait for the one writer, so parallel test files do not queue.
			"SQLITE_JOURNAL_MODE = WAL",
			"[repository]",
			`ROOT = ${join(data, "repos")}`,
			"[server]",
			"HTTP_ADDR = 127.0.0.1",
			`HTTP_PORT = ${PORT}`,
			`ROOT_URL = ${URL_BASE}/`,
			"DISABLE_SSH = true",
			"[service]",
			"DISABLE_REGISTRATION = true",
			"REQUIRE_SIGNIN_VIEW = true",
			"[api]",
			`MAX_RESPONSE_ITEMS = ${API_PAGE}`,
			`DEFAULT_PAGING_NUM = ${API_PAGE}`,
			"[mailer]",
			"ENABLED = false",
			"[log]",
			"LEVEL = Info",
			`ROOT_PATH = ${join(data, "log")}`,
			"",
		].join("\n"),
	);
	await run([binary, "--config", appIni, "migrate"]);
	await run([binary, "--config", appIni, ...adminCreateArgs(password)], {
		quiet: true,
	});
	const proc = Bun.spawn([binary, "--config", appIni, "web"], {
		stdout: Bun.file(join(WORK_DIR, "web.log")),
		stderr: Bun.file(join(WORK_DIR, "web.log")),
	});
	proc.unref();
	try {
		await waitForServer();
		return proc.pid;
	} catch (error) {
		stopPid(proc.pid);
		throw error;
	}
}

function stopPid(pid: number): void {
	// After a reboot the PID can belong to another process; stop only a forgejo.
	const cmdline = `/proc/${pid}/cmdline`;
	if (
		existsSync(cmdline) &&
		!readFileSync(cmdline, "utf8").includes("forgejo")
	) {
		return;
	}
	try {
		process.kill(pid);
	} catch {
		// The process already stopped.
	}
}

async function start(): Promise<void> {
	const existing = await readState();
	if (
		existing?.config === CONFIG_ID &&
		(await versionOk()) &&
		(await tokenWorks(existing.readToken))
	) {
		console.log(
			JSON.stringify({ reused: true, url: existing.url, state: STATE_FILE }),
		);
		return;
	}
	if (existing?.pid) stopPid(existing.pid);
	const mode = pickMode();
	const password = randomSecret();
	let pid: number | undefined;
	if (mode === "podman") await startPodman(password);
	else pid = await startBinary(password);
	try {
		const state: ServerState = {
			version: VERSION,
			config: CONFIG_ID,
			mode,
			url: URL_BASE,
			username: ADMIN_USER,
			password,
			readToken: await createToken(password, "fgj-read", READ_SCOPES),
			writeToken: await createToken(password, "fgj-write", WRITE_SCOPES),
			apiPage: API_PAGE,
			...(pid === undefined ? {} : { pid }),
		};
		await writeState(state);
		console.log(
			JSON.stringify({ reused: false, url: URL_BASE, mode, state: STATE_FILE }),
		);
	} catch (error) {
		if (mode === "podman")
			await run(["podman", "rm", "-f", "--ignore", CONTAINER]);
		else if (pid !== undefined) stopPid(pid);
		await rm(STATE_FILE, { force: true });
		throw error;
	}
}

async function stop(): Promise<void> {
	const state = await readState();
	const mode = state?.mode ?? pickMode();
	if (mode === "podman") {
		await run(["podman", "rm", "-f", "--ignore", CONTAINER]);
	} else if (state?.pid) {
		stopPid(state.pid);
	}
	await rm(STATE_FILE, { force: true });
	console.log(JSON.stringify({ stopped: true, mode }));
}

async function status(): Promise<void> {
	const state = await readState();
	const up = await versionOk();
	console.log(
		JSON.stringify({ up, url: URL_BASE, state: state ? STATE_FILE : null }),
	);
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = { start, stop, status };
const handler = command ? commands[command] : undefined;
if (!handler) {
	console.error(
		"usage: bun scripts/forgejo-test-server.ts <start|stop|status>",
	);
	process.exit(2);
}
await handler();

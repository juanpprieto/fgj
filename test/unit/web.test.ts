import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Tracer } from "../../src/core/trace.ts";
import { checkWebLogin, WebReader, WebWriter } from "../../src/forgejo/web.ts";

const silent: Tracer = { enabled: false, emit() {} };
const login = {
	cookie: "persistent",
	value: "good-remember-cookie",
	expires: new Date(Date.now() + 86_400_000).toISOString(),
};

/**
 * A fake Forgejo web server: `/user/login` renews a session from the remember
 * cookie, and pages under `/git/o/r/` need a live session.
 */
describe("WebReader against a fake server", () => {
	let server: ReturnType<typeof Bun.serve>;
	let base: string;
	let live = new Set<string>();
	let loginStatus = 303;
	let seen: string[] = [];
	let next = 0;
	let createStatus = 303;
	let createLocation: string | undefined = "/git/o/r/projects";

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				seen.push(url.pathname + url.search);
				const cookie = req.headers.get("cookie") ?? "";
				if (url.pathname === "/git/user/login") {
					if (loginStatus !== 303)
						return new Response("x", { status: loginStatus });
					if (!cookie.includes(`persistent=${login.value}`)) {
						return new Response("sign in", { status: 200 });
					}
					const id = `session-id-${++next}`;
					live.add(id);
					return new Response(null, {
						status: 303,
						headers: {
							location: "/git/",
							"set-cookie": `session=${id}; Path=/`,
						},
					});
				}
				const session = /session=([^;]+)/.exec(cookie)?.[1] ?? "";
				if (!live.has(session)) {
					return new Response(null, {
						status: 303,
						headers: { location: "/git/user/login" },
					});
				}
				const to: Record<string, string> = {
					"/git/o/r/issues/1": "/git/o/r/pulls/1?tab=x",
					"/git/o/r/moved": "/git/o/r2/moved",
					"/git/o/r/prefix": "/gitfoo/o/r/x",
				};
				const target = to[url.pathname];
				if (target) {
					return new Response(null, {
						status: 303,
						headers: { location: target },
					});
				}
				if (req.method === "POST") {
					if (url.pathname === "/git/o/r/projects/new") {
						return new Response(null, {
							status: createStatus,
							headers:
								createLocation === undefined
									? {}
									: { location: createLocation },
						});
					}
					const answers: Record<string, [number, string]> = {
						"/git/o/r/ok": [200, '{"ok":true}'],
						"/git/o/r/denied": [403, '{"message":"no"}'],
						"/git/o/r/silent": [200, "{}"],
						"/git/o/r/redirect": [
							200,
							'{"redirect":"http://x/o/r/actions/runs/1/jobs/0/attempt/2"}',
						],
						"/git/o/r/refused": [
							400,
							'{"errorMessage":"This workflow cannot be rerun.","renderFormat":"text"}',
						],
					};
					if (url.pathname === "/git/o/r/drop-post") {
						live = new Set();
						return new Response(null, {
							status: 303,
							headers: { location: "/git/user/login" },
						});
					}
					const [status, body] = answers[url.pathname] ?? [404, "{}"];
					return new Response(body, { status });
				}
				if (url.pathname === "/git/o/r/drop") {
					live = new Set();
					return new Response(null, {
						status: 303,
						headers: { location: "/git/user/login" },
					});
				}
				return new Response(`page ${url.pathname}`, { status: 200 });
			},
		});
		base = `http://127.0.0.1:${server.port}/git`;
	});

	afterAll(() => {
		server.stop(true);
	});

	const reader = () => {
		seen = [];
		return new WebReader(base, login, "t", silent, () => {});
	};

	test("a redirect inside the repository is followed, with its query", async () => {
		loginStatus = 303;
		const page = await reader().page("/o/r/issues/1");
		expect(page?.path).toBe("/o/r/pulls/1?tab=x");
		expect(seen.at(-1)).toBe("/git/o/r/pulls/1?tab=x");
	});

	test("a redirect to another repository or outside the base path fails, never follows", async () => {
		loginStatus = 303;
		const r = reader();
		await expect(r.page("/o/r/moved")).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(r.page("/o/r/prefix")).rejects.toMatchObject({
			code: "api",
		});
		expect(seen.some((p) => p.includes("r2") || p.startsWith("/gitfoo"))).toBe(
			false,
		);
	});

	test("a session that the server drops during a call is renewed once; a second drop fails with auth", async () => {
		loginStatus = 303;
		const r = reader();
		expect((await r.page("/o/r/a"))?.html).toBe("page /git/o/r/a");
		await expect(r.page("/o/r/drop")).rejects.toMatchObject({ code: "auth" });
		expect(seen.filter((p) => p === "/git/user/login")).toHaveLength(2);
	});

	test("a server error during renewal is an api error, not a revoked login", async () => {
		loginStatus = 502;
		await expect(reader().page("/o/r/a")).rejects.toMatchObject({
			code: "api",
		});
		expect(await checkWebLogin(base, login, silent)).toBe("unreachable");
		loginStatus = 303;
		expect(await checkWebLogin(base, login, silent)).toBe("ok");
		expect(
			await checkWebLogin(base, { ...login, value: "revoked-cookie" }, silent),
		).toBe("refused");
	});

	test("creation accepts only the repository list 303 and never repeats an uncertain POST", async () => {
		loginStatus = 303;
		for (const [status, location, code] of [
			[303, "/git/o/r/projects", undefined],
			[303, "http://foreign.invalid/git/o/r/projects", "api"],
			[303, "/git/o/other/projects", "api"],
			[303, undefined, "api"],
			[303, "http://[", "api"],
			[303, "/git/o/r/projects?unexpected=true", "api"],
			[302, "/git/o/r/projects", "api"],
			[200, undefined, "conflict"],
			[500, undefined, "api"],
			[403, undefined, "auth"],
			[404, undefined, "not_found"],
			[303, "/git/user/login", "auth"],
		] as const) {
			createStatus = status;
			createLocation = location;
			seen = [];
			const w = new WebWriter(base, login, "t", silent, () => {});
			const result = w.createProject("/o/r/projects/new", {
				title: "Plan",
				template_type: "1",
				card_type: "1",
				content: "",
			});
			if (code) await expect(result).rejects.toMatchObject({ code });
			else await result;
			expect(seen.filter((p) => p === "/git/o/r/projects/new")).toHaveLength(1);
		}
	});

	test("post: ok is success; 403 is auth; an answer without ok is api; a dropped session renews once", async () => {
		loginStatus = 303;
		seen = [];
		const w = new WebWriter(base, login, "t", silent, () => {});
		await w.post("/o/r/ok", { json: { issues: [] } });
		await expect(w.post("/o/r/denied", { form: {} })).rejects.toMatchObject({
			code: "auth",
		});
		await expect(w.post("/o/r/silent", { form: {} })).rejects.toMatchObject({
			code: "api",
		});
		await expect(w.post("/o/r/missing", { form: {} })).rejects.toMatchObject({
			code: "not_found",
		});
		seen = [];
		await expect(w.post("/o/r/drop-post", { form: {} })).rejects.toMatchObject({
			code: "auth",
		});
		expect(seen.filter((p) => p === "/git/o/r/drop-post")).toHaveLength(2);
	});

	test("post returns Forgejo's answer: ok or a redirect; a 400 with a reason is a conflict that names it", async () => {
		loginStatus = 303;
		const w = new WebWriter(base, login, "t", silent, () => {});
		expect(await w.post("/o/r/ok", { form: {} })).toEqual({ ok: true });
		expect(await w.post("/o/r/redirect", { form: {} })).toEqual({
			redirect: "http://x/o/r/actions/runs/1/jobs/0/attempt/2",
		});
		await expect(w.post("/o/r/refused", { form: {} })).rejects.toMatchObject({
			code: "conflict",
			message: expect.stringContaining("This workflow cannot be rerun."),
		});
	});
});

// node test/local-server.test.ts — local-mode sign-in (web/local/auth.ts) through the real server (web/local/server.ts).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

registerHooks({ resolve: (s, c, next) => { try { return next(s, c); } catch (e) { if (s.startsWith(".")) return next(`${s}.ts`, c); throw e; } } });
const { startLocalServer } = await import("../local/server.ts");
const { isLoopback } = await import("../local/auth.ts");

const TOKEN = "t".repeat(64);
const dir = mkdtempSync(join(tmpdir(), "yanroku-local-server-"));
const start = (host: string, password?: string) =>
  startLocalServer({ dataDir: dir, publicDir: "public", migrationsDir: "migrations", host, port: 0, password, runnerToken: TOKEN, log: () => {} });
// node:http, not fetch: fetch drops a Host header
type Res = { status: number; headers: Headers; text: string; json(): any };
const get = (port: number, path: string, headers: Record<string, string> = {}, init: { method?: string; body?: string | URLSearchParams } = {}) =>
  new Promise<Res>((resolve, reject) => {
    const body = init.body?.toString();
    const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { ...headers, ...(body !== undefined && { "Content-Length": Buffer.byteLength(body) }) } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const x of [v].flat()) if (x !== undefined) h.append(k, x);
        resolve({ status: res.statusCode!, headers: h, text, json: () => JSON.parse(text) });
      });
    });
    req.on("error", reject).end(body);
  });

for (const h of ["127.0.0.1", "127.8.9.10", "localhost", "::1", "[::1]"]) assert.ok(isLoopback(h), h);
for (const h of ["0.0.0.0", "192.168.1.5", "::", "localhost.evil.com", "127.0.0.1.nip.io"]) assert.ok(!isLoopback(h), h);

try {
  // ---- loopback: no sign-in, but only this machine's host names
  let s = await start("127.0.0.1");
  assert.equal((await get(s.port, "/api/recordings")).status, 200);
  assert.equal((await get(s.port, "/api/recordings", { Host: `localhost:${s.port}` })).status, 200);
  assert.equal((await get(s.port, "/api/recordings", { Host: "rebind.evil.com" })).status, 403);
  assert.equal((await get(s.port, "/", { Host: "rebind.evil.com" })).status, 403);
  assert.equal((await get(s.port, "/")).status, 200);
  assert.equal((await get(s.port, "/login")).status, 404); // no sign-in page: falls through to the Worker
  const cfg = (await get(s.port, "/api/config")).json();
  assert.equal(cfg.auth_mode, "local");
  // runner routes: only with the token
  assert.equal((await get(s.port, "/api/runner/claim", {}, { method: "POST" })).status, 401);
  assert.equal((await get(s.port, "/api/runner/claim", { Authorization: "Bearer wrong" }, { method: "POST" })).status, 401);
  const claim = await get(s.port, "/api/runner/claim", { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify({ runner: "t" }) });
  assert.equal(claim.status, 200, claim.text);
  assert.deepEqual(claim.json(), { job: null });
  // cross-site writes are refused (a page on another site posting to 127.0.0.1)
  assert.equal((await get(s.port, "/api/folders", { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" }, { method: "POST", body: "{}" })).status, 403);
  await s.close();

  // ---- not loopback: refuses to start without a password
  await assert.rejects(start("0.0.0.0"), /LOCAL_PASSWORD is required/);

  // ---- password
  s = await start("0.0.0.0", "correct horse");
  assert.equal((await get(s.port, "/api/recordings")).status, 401);
  assert.equal((await get(s.port, "/api/recordings", { Host: "192.168.1.5:1" })).status, 401); // any Host, but signed in only
  let r = await get(s.port, "/");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("Location"), "/login");
  assert.equal((await get(s.port, "/login")).status, 200);
  const form = (p: string, extra: Record<string, string> = {}) =>
    get(s.port, "/login", { "Content-Type": "application/x-www-form-urlencoded", ...extra }, { method: "POST", body: new URLSearchParams({ password: p }).toString() });
  r = await form("wrong");
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("Set-Cookie"), null);
  assert.equal((await form("correct horse", { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await get(s.port, "/login", { "Content-Type": "application/x-www-form-urlencoded" }, { method: "POST", body: "password=" + "x".repeat(5000) })).status, 413);
  // wrong guesses are taken one at a time (1 s each), however many arrive together
  const t0 = Date.now();
  await Promise.all([form("w1"), form("w2"), form("w3")]);
  assert.ok(Date.now() - t0 >= 2900, `3 parallel wrong guesses took ${Date.now() - t0} ms`);
  r = await form("correct horse");
  assert.equal(r.status, 303);
  const setCookie = r.headers.get("Set-Cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const session = setCookie.split(";")[0];
  assert.equal((await get(s.port, "/api/recordings", { Cookie: session })).status, 200);
  assert.equal((await get(s.port, "/", { Cookie: session })).status, 200);
  assert.equal((await get(s.port, "/api/recordings", { Cookie: session.replace(/.$/, (c) => (c === "A" ? "B" : "A")) })).status, 401); // tampered
  const [name, value] = session.split("=");
  assert.equal((await get(s.port, "/api/recordings", { Cookie: `${name}=1.${value.split(".")[1]}` })).status, 401); // expired / re-dated
  assert.equal((await get(s.port, "/api/runner/claim", { Cookie: session }, { method: "POST" })).status, 401); // a session is not the runner
  await s.close();

  // a new password signs everyone out
  s = await start("0.0.0.0", "new password");
  assert.equal((await get(s.port, "/api/recordings", { Cookie: session })).status, 401);
  await s.close();

  // ---- a busy port is a clear error
  const a = await start("127.0.0.1");
  await assert.rejects(startLocalServer({ dataDir: join(dir, "b"), publicDir: "public", migrationsDir: "migrations", host: "127.0.0.1", port: a.port, runnerToken: TOKEN, log: () => {} }), /already in use/);
  await a.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("local server ok");

// The Worker (src/app.ts) on node:http, for `yanroku up` (local mode): D1 → node:sqlite (d1.ts), R2 → files (r2.ts),
// Cloudflare Access → auth.ts, static assets → public/ (as wrangler's "assets": /api/* and /media/* go to the Worker,
// everything else is a file from public/ if there is one).
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { createWorker, type Identify } from "../src/app.ts";
import type { Env } from "../src/http.ts";
import { LocalAuth, isLoopback } from "./auth.ts";
import { LocalD1 } from "./d1.ts";
import { migrate } from "./migrate.ts";
import { LocalR2 } from "./r2.ts";

export interface LocalOptions {
  dataDir: string; // yanroku.db, audio/, secret
  publicDir: string;
  migrationsDir: string;
  host: string;
  port: number;
  password?: string;
  runnerToken: string;
  vars?: Partial<Record<"VOICE_MATCH_THRESHOLD" | "VOICE_SUGGEST_THRESHOLD" | "TRANSFER_ENABLED" | "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT", string>>;
  log?: (msg: string) => void;
  identify?: Identify; // tests only: replaces local sign-in (test/isolation-local.test.ts)
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".otf": "font/otf", ".woff2": "font/woff2",
};

function loadSecret(path: string) {
  if (existsSync(path)) return readFileSync(path);
  const s = randomBytes(32);
  writeFileSync(path, s, { mode: 0o600 });
  return s;
}

const loginPage = (error: boolean) => `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Yanroku 言錄</title><link rel="icon" href="/icon.svg">
<style>body{font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f4f0;color:#222}
form{background:#fff;padding:28px;border-radius:14px;box-shadow:0 2px 12px #0001;display:grid;gap:12px;width:min(320px,90vw)}
h1{font-size:20px;margin:0 0 4px}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #ccc}
button{background:#0f766e;color:#fff;border:0;cursor:pointer}p{color:#b42318;margin:0;font-size:14px}</style></head>
<body><form method="post" action="/login"><h1>Yanroku 言錄</h1>
<input type="password" name="password" placeholder="密碼 / Password" autocomplete="current-password" autofocus required>
${error ? "<p>密碼錯誤 / Wrong password</p>" : ""}<button>登入 / Sign in</button></form></body></html>`;

/** The body as text, or null once it passes max bytes (reading stops there). */
async function readCapped(r: Request, max: number): Promise<string | null> {
  if (!r.body) return "";
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > max) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream);
  return new Request(url, { method: req.method, headers, body, duplex: "half" } as RequestInit);
}

async function send(res: ServerResponse, r: Response, head: boolean) {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(r.status, headers);
  if (head || !r.body) {
    res.end();
    await r.body?.cancel().catch(() => {});
    return;
  }
  await new Promise<void>((resolve) => {
    const body = Readable.fromWeb(r.body as never);
    body.on("error", () => res.destroy()).pipe(res);
    res.on("close", () => {
      body.destroy();
      resolve();
    });
  });
}

export async function startLocalServer(o: LocalOptions) {
  const log = o.log ?? ((m: string) => console.log(m));
  mkdirSync(o.dataDir, { recursive: true });
  const d1 = new LocalD1(join(o.dataDir, "yanroku.db"));
  const applied = migrate(d1, o.migrationsDir);
  if (applied.length) log(`applied migrations: ${applied.join(", ")}`);
  const r2 = new LocalR2(join(o.dataDir, "audio"));
  await r2.pruneUploads();
  const prune = setInterval(() => r2.pruneUploads().catch(() => {}), 24 * 3600_000).unref();

  const loopback = isLoopback(o.host);
  const auth = new LocalAuth({ loopback, password: o.password || undefined, runnerToken: o.runnerToken, secret: loadSecret(join(o.dataDir, "secret")) });
  const env = { DB: d1, AUDIO: r2, ACCESS_TEAM: "", ACCESS_AUD: "", ...o.vars } as unknown as Env;
  const worker = createWorker({ identify: o.identify ?? auth.identify, config: () => ({ auth_mode: "local" }) });

  const pending = new Set<Promise<unknown>>();
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      const q = p.catch((e) => log(`background task failed: ${(e as Error)?.message ?? e}`)).finally(() => pending.delete(q));
      pending.add(q);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;

  const publicRoot = normalize(o.publicDir + sep);
  function asset(pathname: string): string | null {
    let p: string;
    try {
      p = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (p.includes("\0")) return null;
    if (p.endsWith("/")) p += "index.html";
    const file = normalize(join(publicRoot, p));
    if (!file.startsWith(publicRoot)) return null;
    try {
      return statSync(file).isFile() ? file : null;
    } catch {
      return null;
    }
  }

  let loginQueue: Promise<unknown> = Promise.resolve();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    let request: Request;
    try {
      request = toRequest(req);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const url = new URL(request.url);
    const head = request.method === "HEAD";
    if (!auth.hostAllowed(request)) return send(res, Response.json({ detail: "forbidden host" }, { status: 403 }), head);

    if (url.pathname === "/login" && auth.needsLogin) {
      if (request.method === "POST") {
        if (["cross-site", "same-site"].includes(request.headers.get("Sec-Fetch-Site") ?? "")) return send(res, new Response("cross-site request", { status: 403 }), false);
        if (Number(request.headers.get("Content-Length") ?? 0) > 4096) return send(res, new Response("too large", { status: 413 }), false);
        const body = await readCapped(request, 4096);
        if (body === null) return send(res, new Response("too large", { status: 413 }), false);
        // one guess at a time, each wrong one holds the line for a second: parallel requests don't speed up guessing
        const ok = await (loginQueue = loginQueue.then(async () => {
          if (auth.checkPassword(new URLSearchParams(body).get("password") ?? "")) return true;
          await new Promise((r) => setTimeout(r, 1000));
          return false;
        }));
        if (ok) return send(res, new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": auth.issue() } }), false);
        return send(res, new Response(loginPage(true), { status: 401, headers: { "Content-Type": TYPES[".html"] } }), false);
      }
      return send(res, new Response(loginPage(false), { headers: { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" } }), head);
    }
    if (url.pathname === "/logout" && auth.needsLogin) return send(res, new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": LocalAuth.clear() } }), head);

    const toWorker = url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/");
    const file = !toWorker && (request.method === "GET" || head) ? asset(url.pathname) : null;
    if (file) {
      if (!auth.signedIn(request)) return send(res, new Response(null, { status: 302, headers: { Location: "/login" } }), head);
      const st = statSync(file);
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const headers = { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", ETag: etag, "Cache-Control": "public, max-age=0, must-revalidate" };
      if (request.headers.get("If-None-Match") === etag) return send(res, new Response(null, { status: 304, headers }), true);
      return send(res, new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { ...headers, "Content-Length": String(st.size) } }), head);
    }
    let r: Response;
    try {
      r = await worker.fetch!(request as never, env, ctx);
    } catch (e) {
      log(`${request.method} ${url.pathname}: ${(e as Error)?.stack ?? e}`);
      r = Response.json({ detail: "internal error" }, { status: 500 });
    }
    return send(res, r as Response, head);
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e) => {
      log(`request failed: ${(e as Error)?.stack ?? e}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
  const listen = (host: string) =>
    new Promise<Server>((resolve, reject) => {
      const s = createServer({ requestTimeout: 0 }, onRequest);
      s.once("error", reject);
      s.listen(o.port, host, () => resolve(s));
    });

  const servers: Server[] = [];
  try {
    const bind = o.host === "localhost" ? "127.0.0.1" : o.host;
    servers.push(await listen(bind));
    // the runner talks to 127.0.0.1 (it only allows plain http there); a wildcard bind already covers it
    if (!["0.0.0.0", "::", "127.0.0.1"].includes(bind)) servers.push(await listen("127.0.0.1"));
  } catch (e) {
    servers.forEach((s) => s.close());
    d1.close();
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") throw new Error(`port ${o.port} is already in use (set LOCAL_PORT or --port)`);
    if (err.code === "EADDRNOTAVAIL") throw new Error(`cannot listen on ${o.host}: not an address of this machine`);
    throw e;
  }
  const port = (servers[0].address() as AddressInfo).port;

  return {
    port,
    loopback,
    db: d1.db,
    async close() {
      clearInterval(prune);
      await Promise.all(servers.map((s) => new Promise((r) => {
        s.close(r);
        setTimeout(() => s.closeAllConnections(), 5000).unref();
      })));
      await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 5000))]);
      d1.close();
    },
  };
}

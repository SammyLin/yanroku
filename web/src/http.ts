export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  ACCESS_TEAM: string;
  ACCESS_AUD: string;
  DEV_NO_AUTH?: string;
  VOICE_MATCH_THRESHOLD?: string;
  VOICE_SUGGEST_THRESHOLD?: string;
  VAPID_PUBLIC_KEY?: string; // Web Push, see push.ts
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  TRANSFER_ENABLED?: string; // "1" = export / import on (transfer.ts)
}

// uid = the caller's users.id (user routes); runner routes get 0 and act on each job row's user_id.
export type Handler<E extends Env = Env> = (req: Request, env: E, params: string[], url: URL, ctx: ExecutionContext, uid: number) => Promise<unknown>;

export class HttpError extends Error {
  readonly status: number; // no parameter property: node's type stripping (test/idor.test.ts imports the routes) can't erase one
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// constant time: compares SHA-256 digests, so neither content nor length leaks through timing
export async function sameSecret(a: string, b: string) {
  const d = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([d(a), d(b)]);
  return x.reduce((acc, v, i) => acc | (v ^ y[i]), 0) === 0;
}

export const errorResponse = (status: number, detail: string) => Response.json({ detail }, { status });

export async function readJSON<T = Record<string, unknown>>(req: Request): Promise<T> {
  // a plain HTML form can't send application/json, so this also blocks form-based CSRF
  if (!req.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
  try {
    const v = await req.json();
    if (v && typeof v === "object") return v as T;
  } catch {}
  throw new HttpError(400, "invalid JSON body");
}

export async function first<T = Record<string, unknown>>(stmt: D1PreparedStatement, notFound = "not found"): Promise<T> {
  const row = await stmt.first<T>();
  if (!row) throw new HttpError(404, notFound);
  return row;
}

export function runnerName(body: { runner?: unknown }): string {
  if (typeof body.runner !== "string" || !body.runner.trim()) throw new HttpError(400, "runner required");
  return body.runner.trim();
}

// Mirrors the Go version: base name, lowercase ascii extension (else .bin), title = stem.
export function splitFilename(raw: string): { name: string; ext: string; stem: string } {
  let name = raw.replaceAll("\\", "/").split("/").pop() || "";
  if (!name || name === ".") name = "upload";
  const dot = name.lastIndexOf(".");
  const rawExt = dot >= 0 ? name.slice(dot) : "";
  const stem = rawExt ? name.slice(0, dot) || name : name;
  const ext = /^\.[a-z0-9]{1,9}$/.test(rawExt.toLowerCase()) ? rawExt.toLowerCase() : ".bin";
  return { name, ext, stem };
}

export type Part = { part: number; etag: string };

export function parseParts(body: { parts?: unknown }): R2UploadedPart[] {
  const parts = body.parts;
  if (!Array.isArray(parts) || !parts.length || !parts.every((p: Part) => Number.isInteger(p?.part) && typeof p?.etag === "string"))
    throw new HttpError(400, "parts: [{part, etag}] required");
  return parts.map((p: Part) => ({ partNumber: p.part, etag: p.etag })).sort((a, b) => a.partNumber - b.partNumber);
}

export function partNumber(s: string | null): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw new HttpError(400, "part must be 1..10000");
  return n;
}

// Streams an R2 object honoring a single "bytes=" range (206 / 416); anything else gets the whole object.
export async function serveR2(req: Request, bucket: R2Bucket, key: string, contentType?: string): Promise<Response> {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range")?.trim() ?? "");
  let range: { offset: number; length: number } | undefined;
  if (m && (m[1] || m[2]) && !(m[1] && m[2] && Number(m[2]) < Number(m[1]))) {
    const head = await bucket.head(key);
    if (!head) return errorResponse(404, "not found");
    const size = head.size;
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])); // "bytes=-N" = last N bytes
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" } });
    range = { offset: start, length: end - start + 1 };
  }
  const obj = await bucket.get(key, range ? { range } : {});
  if (!obj) return errorResponse(404, "not found");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (contentType) headers.set("Content-Type", contentType);
  headers.set("ETag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-cache");
  if (!range) {
    headers.set("Content-Length", String(obj.size));
    return new Response(obj.body, { headers });
  }
  headers.set("Content-Length", String(range.length));
  headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`);
  return new Response(obj.body, { status: 206, headers });
}

// D1 failures that say nothing about the request itself. "network" / "reset" / "internal" / "timeout" usually pass on a
// second try; "nomem" (SQLITE_NOMEM) means the statement was too heavy, so it is never retried inline (the same statement
// would fail the same way) — shrink the query instead. Either way the caller gets 503 + Retry-After (d1ErrorResponse).
export type D1Class = "network" | "reset" | "internal" | "nomem" | "timeout" | null;

export function d1Class(e: unknown): D1Class {
  if (e instanceof HttpError) return null;
  const msg = String((e as Error)?.message ?? e);
  if (/Network connection lost/i.test(msg)) return "network";
  if (/storage caused object to be reset|reset because its code was updated/i.test(msg)) return "reset";
  if (/Replica disconnected from primary|transient issue on remote node/i.test(msg)) return "network";
  if (/SQLITE_NOMEM|out of memory/i.test(msg)) return "nomem";
  if (/D1_ERROR:.*timed out/i.test(msg)) return "timeout";
  if (/D1_ERROR:.*internal error/i.test(msg)) return "internal";
  return null;
}

/** Worth repeating as is: a D1 hiccup, not a heavy (nomem) or broken statement. */
export function isTransientD1(e: unknown): boolean {
  const c = d1Class(e);
  return c !== null && c !== "nomem";
}

// Seconds a client should wait after a 503: short for a hiccup, longer when D1 ran out of memory.
export const D1_RETRY_AFTER_S = 2;
export const D1_NOMEM_RETRY_AFTER_S = 30;
export const D1_ATTEMPTS = 3; // 1 try + 2 retries

/**
 * Runs fn again (up to `attempts` in all, full jitter, < 150 ms of waiting by default) when it fails with a transient D1
 * error. Only for reads and for writes that are safe to repeat; anything else is thrown at once.
 */
export async function retryIdempotent<T>(fn: () => Promise<T>, attempts = D1_ATTEMPTS, baseMs = 50): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isTransientD1(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * baseMs * 2 ** (i - 1)));
    }
  }
}

/**
 * 503 + Retry-After for a D1 failure that outlived retryIdempotent (runners back off and claim again), else null.
 * x-yanroku-transient marks the hiccups (an embedder may report them as warnings); nomem stays an error worth fixing.
 */
export function d1ErrorResponse(e: unknown, detail: string): Response | null {
  const cls = d1Class(e);
  if (!cls) return null;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Retry-After": String(cls === "nomem" ? D1_NOMEM_RETRY_AFTER_S : D1_RETRY_AFTER_S),
    "x-yanroku-d1-class": cls,
  };
  if (cls !== "nomem") headers["x-yanroku-transient"] = "d1";
  return new Response(JSON.stringify({ detail }), { status: 503, headers });
}

// Ported from runner/pipeline.go (ids + names only; prompts stay in the runner).
export const templates = [{ id: "meeting", name: "會議摘要" }];
export const languages = [
  { id: "zh-TW", name: "繁體中文（台灣）" },
  { id: "en", name: "English" },
  { id: "ja", name: "日本語" },
];

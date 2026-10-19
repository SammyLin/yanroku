// Sign-in for `yanroku up` (local mode). One user (uid 1, as with Cloudflare Access self-host).
// - Bound to loopback: no sign-in, but only Host: localhost / 127.0.0.1 / [::1] is served, so a page on another site
//   that resolves its own name to 127.0.0.1 (DNS rebinding) gets nothing.
// - Bound to anything else: LOCAL_PASSWORD is required; /login trades it for a session cookie.
// - /api/runner/*: only the runner `yanroku up` started, with the token it generated (Authorization: Bearer).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Identify } from "../src/app.ts";

export const SESSION_COOKIE = "yanroku_session";
const SESSION_DAYS = 30;

export function isLoopback(host: string) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

function sameString(a: string, b: string) {
  const x = createHmac("sha256", "cmp").update(a).digest();
  const y = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(x, y);
}

function cookie(req: Request, name: string) {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export interface AuthOptions {
  loopback: boolean; // the address the server listens on
  password?: string; // required unless loopback
  runnerToken: string;
  secret: Uint8Array; // signs session cookies (data/web/secret)
}

export class LocalAuth {
  readonly #o: AuthOptions;
  readonly #key: Buffer;

  constructor(o: AuthOptions) {
    if (!o.loopback && !o.password) throw new Error("LOCAL_PASSWORD is required when the server listens on a non-loopback address");
    if (o.runnerToken.length < 32) throw new Error("runner token too short");
    this.#o = o;
    // changing the password signs everyone out
    this.#key = createHmac("sha256", o.secret).update(`session:${o.password ?? ""}`).digest();
  }

  get needsLogin() {
    return !this.#o.loopback;
  }

  /** Loopback only: is the Host header one of this machine's names? */
  hostAllowed(req: Request) {
    if (!this.#o.loopback) return true;
    const host = req.headers.get("Host");
    if (!host) return false;
    const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
    return isLoopback(name);
  }

  checkPassword(p: string) {
    return !!this.#o.password && sameString(p, this.#o.password);
  }

  #sign(exp: string) {
    return createHmac("sha256", this.#key).update(exp).digest("base64url");
  }

  /** Set-Cookie value for a new session. */
  issue(now = Date.now()) {
    const exp = String(Math.floor(now / 1000) + SESSION_DAYS * 86400);
    return `${SESSION_COOKIE}=${exp}.${this.#sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
  }

  static clear() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  signedIn(req: Request, now = Date.now()) {
    if (!this.needsLogin) return true;
    const v = cookie(req, SESSION_COOKIE);
    const [exp, sig] = v?.split(".") ?? [];
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) <= now / 1000) return false;
    return sameString(sig, this.#sign(exp));
  }

  identify: Identify = async (req, _env, path) => {
    if (path.startsWith("/api/runner/")) {
      const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
      return m && sameString(m[1], this.#o.runnerToken) ? { runner: true } : Response.json({ detail: "unauthorized" }, { status: 401 });
    }
    if (!this.hostAllowed(req)) return Response.json({ detail: "forbidden host" }, { status: 403 });
    return this.signedIn(req) ? { uid: 1 } : Response.json({ detail: "unauthorized" }, { status: 401 });
  };
}

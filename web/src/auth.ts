// Cloudflare Access JWT verification (verifyRs256 is the generic RS256/JWKS core, exported for other entries) (RS256, WebCrypto). No imports so node can run test/auth.test.ts directly.

type Jwk = JsonWebKey & { kid?: string };
type Claims = { aud?: string | string[]; exp?: number; nbf?: number; iss?: string; email?: string; common_name?: string };

const CERT_TTL_MS = 3600_000;
const certs = new Map<string, { at: number; keys: Jwk[] }>(); // per JWKS URL

async function jwks(url: string, force: boolean): Promise<Jwk[]> {
  const c = certs.get(url);
  if (!force && c && Date.now() - c.at < CERT_TTL_MS) return c.keys;
  if (force && c && Date.now() - c.at < 60_000) return c.keys; // unknown kid: refetch at most once a minute
  const res = await fetch(url);
  if (!res.ok) throw new Error(`jwks ${url}: HTTP ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  certs.set(url, { at: Date.now(), keys });
  return keys;
}

function b64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** RS256 signature (key from the JWKS at `url`), exp/nbf and iss; null on any failure. */
export async function verifyRs256<C extends Claims>(token: string | null, url: string, iss: string, now: number): Promise<C | null> {
  const parts = token?.split(".");
  if (!parts || parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(parts[0]))) as { alg?: string; kid?: string };
    const claims = JSON.parse(new TextDecoder().decode(b64url(parts[1]))) as C;
    if (header.alg !== "RS256") return null;
    let jwk = (await jwks(url, false)).find((k) => k.kid === header.kid);
    jwk ??= (await jwks(url, true)).find((k) => k.kid === header.kid); // key rotation
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    if (typeof claims.exp !== "number" || claims.exp <= now) return null;
    if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
    if (claims.iss !== undefined && claims.iss !== iss) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Returns the token's claims, or null when it is missing, malformed, badly signed, expired or for another audience. */
export async function verifyAccessJwt(token: string | null, team: string, aud: string, now = Date.now() / 1000): Promise<Claims | null> {
  const base = `https://${team}.cloudflareaccess.com`;
  const claims = await verifyRs256(token, `${base}/cdn-cgi/access/certs`, base, now);
  const auds = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  return claims && auds.includes(aud) ? claims : null;
}

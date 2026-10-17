// Export / import (transfer.ts): the TRANSFER_ENABLED switch and the pure merge rules. Type-only imports: node tests import this file.
import type { Env } from "./http";
import type { Settings } from "./settings";

/** The whole feature is off unless the deployment sets TRANSFER_ENABLED=1 (wrangler vars / .dev.vars). */
export const transferEnabled = (env: Env) => env.TRANSFER_ENABLED === "1";
export const EXPORT_FORMAT = "yanroku-export";
export const EXPORT_VERSION = 1;
type IdMap = Record<string | number, number>;

/** null when the zip's manifest is one this server reads; otherwise why not (checked before anything is written). */
export function checkManifest(m: unknown): string | null {
  const o = m as { format?: unknown; version?: unknown } | null;
  if (!o || typeof o !== "object" || o.format !== EXPORT_FORMAT) return "not a Yanroku export";
  if (o.version !== EXPORT_VERSION) return `unsupported export version ${String(o.version)}`;
  return null;
}

type Validate = (patch: Record<string, unknown>) => Partial<Settings> | string; // settings.ts parseSettings (passed in: type-only imports here)

/** Settings to write on import: only keys the account hasn't set (`existing` = its stored rows; the web app saves every
 *  key, so a stored value still equal to its default counts as unset), each valid on its own; `me` follows the imported
 *  person; vocab is the union, the account's own terms first, capped at 200. */
export function mergeSettings(existing: Record<string, unknown>, incoming: Record<string, unknown>, people: IdMap, parseSettings: Validate,
  defaults: Record<string, unknown> = {}): Partial<Settings> {
  const out: Record<string, unknown> = {};
  const isSet = (k: string) => k in existing && JSON.stringify(existing[k]) !== JSON.stringify(defaults[k]);
  for (const [k, v] of Object.entries(incoming ?? {})) {
    if (k === "vocab" || isSet(k)) continue;
    const value = k === "me" ? (v == null ? null : people[v as number] ?? undefined) : v;
    if (value === undefined) continue;
    const ok = parseSettings({ [k]: value });
    if (typeof ok !== "string") Object.assign(out, ok);
  }
  if (Array.isArray(incoming?.vocab)) {
    const terms = [...new Set([...((existing.vocab as string[]) ?? []), ...incoming.vocab.filter((t): t is string => typeof t === "string")])];
    const ok = parseSettings({ vocab: terms.slice(0, 200) });
    if (typeof ok !== "string") Object.assign(out, ok);
  }
  return out as Partial<Settings>;
}

const CITE = /\[\[([^\]]+)\]\]/g; // as in ask.ts: [[id@mm:ss]], several per bracket separated by commas

/** 問問看 answers cite recordings as [[id@mm:ss]]: map each id; a citation to a recording that wasn't imported is dropped. */
export const rewriteCitations = (md: string, map: IdMap) => md.replace(CITE, (_, inner: string) => {
  const kept = inner.split(",").map((p) => p.trim()).flatMap((p) => {
    const m = /^(\d+)@(.*)$/.exec(p);
    return m && map[m[1]] ? [`${map[m[1]]}@${m[2]}`] : [];
  });
  return kept.length ? `[[${kept.join(", ")}]]` : "";
});

export const mapSources = (sources: number[], map: IdMap) => sources.flatMap((s) => (map[s] ? [map[s]] : []));

/** Folders parents-first so each one's new parent id exists when it is created. A missing parent or a cycle → a root. */
export function folderPlan<F extends { id: number; parent_id: number | null }>(folders: F[]): F[] {
  const ids = new Set(folders.map((f) => f.id));
  const done = new Set<number>();
  const out: F[] = [];
  const walk = (roots: F[]) => {
    const queue = [...roots];
    for (const r of roots) done.add(r.id);
    while (queue.length) {
      const f = queue.shift()!;
      out.push(f);
      for (const k of folders) if (k.parent_id === f.id && !done.has(k.id)) done.add(k.id), queue.push(k);
    }
  };
  walk(folders.filter((f) => f.parent_id == null || !ids.has(f.parent_id)).map((f) => ({ ...f, parent_id: null })));
  for (const f of folders) if (!done.has(f.id)) walk([{ ...f, parent_id: null }]);
  return out;
}

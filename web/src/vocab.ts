// Vocabulary suggestions (詞彙建議): runners scan recordings for ASR-worthy terms (claim/result live in runner.ts);
// the user adds (→ end of settings.vocab) or dismisses each. Never changes settings.vocab by itself.
import { type Env, type Handler, HttpError, readJSON, retryIdempotent } from "./http";
import { getSettings, putSettings } from "./settings";

export const SCAN_SIZE = 10; // recordings per scan; the next scan continues after to_id
const DIFFS_PER_REC = 150;
const TEXT_CHARS = 20_000;
const SCAN_PAGE = 500; // segments per statement in scanSegments
const KINDS = ["product", "company", "person", "term", "other"];
const PROCESSING = `('queued','converting','transcribing','cleaning')`;

// Unscanned = the user's done recordings past their last done scan, stopping before any of theirs still in the pipeline
// (otherwise a recording that finishes later with a lower id would be skipped for good). `u` = the uid parameter.
const unscanned = (u: string) => `user_id=${u} AND status='done' AND deleted_at IS NULL
  AND id > coalesce((SELECT max(to_id) FROM vocab_scans WHERE user_id=${u} AND status='done'), 0)
  AND id < coalesce((SELECT min(id) FROM recordings WHERE user_id=${u} AND deleted_at IS NULL AND status IN ${PROCESSING}), 9223372036854775807)`;

// Queues a scan of user `uid`'s oldest SCAN_SIZE unscanned recordings, in one statement (two claiming runners can't both insert).
// Automatic: needs ≥ SCAN_SIZE unscanned, or ≥ 1 and no done scan in 24 h; and no failed scan in the last hour (no retry storm).
export const queueScan = (env: Env, uid: number, force: boolean) =>
  env.DB.prepare(`INSERT INTO vocab_scans(from_id, to_id, user_id)
    SELECT lo, hi, ?2 FROM (SELECT min(id) AS lo, max(id) AS hi, count(*) AS n FROM (SELECT id FROM recordings WHERE ${unscanned("?2")} ORDER BY id LIMIT ${SCAN_SIZE}))
    WHERE n >= 1 AND NOT EXISTS(SELECT 1 FROM vocab_scans WHERE user_id=?2 AND status IN ('queued','running'))
      AND (?1 OR ((n >= ${SCAN_SIZE} OR NOT EXISTS(SELECT 1 FROM vocab_scans WHERE user_id=?2 AND status='done' AND created_at > datetime('now','-24 hours')))
        AND NOT EXISTS(SELECT 1 FROM vocab_scans WHERE user_id=?2 AND status='error' AND created_at > datetime('now','-1 hour'))))
    RETURNING id`).bind(force ? 1 : 0, uid).first<{ id: number }>();

// Users with done recordings past their last done scan (claim-time candidates for queueScan).
// Random so users whose scan is not due yet can't starve the rest.
// ponytail: the runner tries a handful per claim; a per-user scan queue belongs to Phase 2 if this gets crowded.
export const scanCandidates = async (env: Env) =>
  (await env.DB.prepare(`SELECT user_id FROM (SELECT DISTINCT user_id FROM recordings r WHERE status='done' AND deleted_at IS NULL
    AND id > coalesce((SELECT max(to_id) FROM vocab_scans v WHERE v.user_id=r.user_id AND v.status='done'), 0)) ORDER BY random() LIMIT 5`)
    .all<{ user_id: number }>()).results.map((r) => r.user_id);

// Letters/digits only: whitespace- and punctuation-only cleanup changes are not vocabulary fixes.
const bare = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
const isDiff = (s: { text_raw: string; text_clean: string | null }): s is { text_raw: string; text_clean: string } =>
  s.text_clean !== null && bare(s.text_raw) !== bare(s.text_clean);

// Claim material for one recording: segments where cleanup changed words, and the cleaned text.
export function scanMaterial(segs: { text_raw: string; text_clean: string | null }[]) {
  const diffs = segs.filter(isDiff)
    .slice(0, DIFFS_PER_REC).map((s) => ({ raw: s.text_raw, clean: s.text_clean! }));
  return { diffs, text: segs.map((s) => s.text_clean ?? s.text_raw).join("\n").slice(0, TEXT_CHARS) };
}

// Segments of one recording, page by page, until scanMaterial has all it can use (TEXT_CHARS of text and DIFFS_PER_REC diffs):
// one D1 batch with every segment of SCAN_SIZE recordings was big enough to run D1 out of memory (SQLITE_NOMEM).
async function scanSegments(env: Env, rid: number) {
  const out: { text_raw: string; text_clean: string | null }[] = [];
  let chars = 0, diffs = 0, lastMs = -1, lastId = -1;
  while (chars <= TEXT_CHARS || diffs < DIFFS_PER_REC) { // chars counts a "\n" per line: joined length = chars - 1
    const { results } = await retryIdempotent(() => env.DB.prepare(`SELECT id, start_ms, text_raw, text_clean FROM segments
      WHERE recording_id=?1 AND (start_ms > ?2 OR (start_ms = ?2 AND id > ?3)) ORDER BY start_ms, id LIMIT ?4`)
      .bind(rid, lastMs, lastId, SCAN_PAGE).all<{ id: number; start_ms: number; text_raw: string; text_clean: string | null }>());
    for (const r of results) {
      out.push({ text_raw: r.text_raw, text_clean: r.text_clean });
      chars += (r.text_clean ?? r.text_raw).length + 1;
      if (isDiff(r)) diffs++;
      lastMs = r.start_ms, lastId = r.id;
    }
    if (results.length < SCAN_PAGE) break;
  }
  return out;
}

export async function scanJob(env: Env, scan: { id: number; from_id: number; to_id: number; user_id: number }) {
  const { results: recs } = await retryIdempotent(() => env.DB.prepare(`SELECT id, title FROM recordings
    WHERE id BETWEEN ?1 AND ?2 AND user_id=?3 AND status='done' AND deleted_at IS NULL ORDER BY id`).bind(scan.from_id, scan.to_id, scan.user_id).all<{ id: number; title: string }>());
  const segs: Awaited<ReturnType<typeof scanSegments>>[] = [];
  for (const r of recs) segs.push(await scanSegments(env, r.id));
  const { results: skip } = await retryIdempotent(() => env.DB.prepare(`SELECT term FROM vocab_suggestions WHERE user_id=? AND status<>'new'`).bind(scan.user_id).all<{ term: string }>());
  const { vocab } = await retryIdempotent(() => getSettings(env, scan.user_id));
  return { kind: "vocab", id: scan.id, vocab, skip: skip.map((s) => s.term),
    recordings: recs.map((r, i) => ({ ...r, ...scanMaterial(segs[i]) })) };
}

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() && [...v.trim()].length <= max ? v.trim() : null);

// Normalised runner terms: [{term ≤ 50, misheard ≤ 10 × ≤ 50, kind}], deduped by term; anything malformed is dropped.
export function parseTerms(v: unknown) {
  if (!Array.isArray(v)) throw new HttpError(400, "terms: [{term, misheard?, kind?}] required");
  const out = new Map<string, { term: string; misheard: string[]; kind: string }>();
  for (const t of v.slice(0, 50)) {
    const term = text(t?.term, 50);
    if (!term || out.has(term)) continue;
    const misheard = [...new Set<string>((Array.isArray(t.misheard) ? t.misheard : []).map((m: unknown) => text(m, 50))
      .filter((m: string | null) => !!m && m !== term))].slice(0, 10);
    out.set(term, { term, misheard, kind: KINDS.includes(t.kind) ? t.kind : "other" });
  }
  return [...out.values()];
}

// Upserts user `uid`'s terms (misheard merged; status kept, so added/dismissed never come back) and recounts them over their recordings.
// ponytail: each touched term scans every segment of the user 3x (instr); fine for hundreds of recordings, add an FTS index if it gets slow.
export function saveTerms(env: Env, uid: number, terms: ReturnType<typeof parseTerms>) {
  const j = JSON.stringify(terms);
  const live = `segments g JOIN recordings r ON r.id=g.recording_id AND r.deleted_at IS NULL
    WHERE g.user_id=?2 AND instr(coalesce(g.text_clean, g.text_raw), vocab_suggestions.term)`;
  return [
    env.DB.prepare(`INSERT INTO vocab_suggestions(user_id, term, misheard, kind)
      SELECT ?2, value->>'term', value->'misheard', value->>'kind' FROM json_each(?1) WHERE true
      ON CONFLICT(user_id, term) DO UPDATE SET kind=coalesce(kind, excluded.kind), misheard=(SELECT json_group_array(value) FROM
        (SELECT value FROM json_each(vocab_suggestions.misheard) UNION SELECT value FROM json_each(excluded.misheard)))`).bind(j, uid),
    env.DB.prepare(`UPDATE vocab_suggestions SET updated_at=datetime('now'),
        hits=(SELECT count(*) FROM ${live}),
        recordings=(SELECT count(DISTINCT g.recording_id) FROM ${live}),
        fixes=(SELECT count(*) FROM ${live} AND g.text_clean IS NOT NULL
          AND EXISTS(SELECT 1 FROM json_each(vocab_suggestions.misheard) m WHERE instr(g.text_raw, m.value)))
      WHERE user_id=?2 AND term IN (SELECT value->>'term' FROM json_each(?1))`).bind(j, uid),
  ];
}

const term = async (req: Request) => {
  const t = text((await readJSON<{ term?: unknown }>(req)).term, 50);
  if (!t) throw new HttpError(400, "term required");
  return t;
};

export const vocabRoutes: [string, RegExp, Handler][] = [
  // new suggestions by score (a repeated cleanup fix weighs 3 hits), minus terms already in the vocab list
  ["GET", /^\/api\/vocab\/suggestions$/, async (_req, env, _p, _u, _c, uid) => {
    const [{ results }, last, pending, { vocab }] = await Promise.all([
      env.DB.prepare(`SELECT term, misheard, kind, hits, fixes, recordings FROM vocab_suggestions WHERE user_id=? AND status='new' AND hits > 0
        ORDER BY fixes*3 + hits + recordings*0.5 DESC, term LIMIT 80`).bind(uid).all<{ term: string; misheard: string }>(),
      env.DB.prepare(`SELECT created_at AS at, status, error FROM vocab_scans WHERE user_id=? ORDER BY id DESC LIMIT 1`).bind(uid).first(),
      env.DB.prepare(`SELECT count(*) AS n FROM recordings WHERE ${unscanned("?1")}`).bind(uid).first<{ n: number }>(),
      getSettings(env, uid),
    ]);
    const have = new Set(vocab);
    return { suggestions: results.filter((r) => !have.has(r.term)).slice(0, 50).map((r) => ({ ...r, misheard: JSON.parse(r.misheard) })),
      last_scan: last, pending: pending?.n ?? 0 };
  }],

  ["POST", /^\/api\/vocab\/suggestions\/add$/, async (req, env, _p, _u, _c, uid) => {
    const t = await term(req);
    const { vocab } = await getSettings(env, uid);
    if (!vocab.includes(t)) {
      if (vocab.length >= 200) throw new HttpError(409, "詞彙已滿 200 個，請先移除一些再加入");
      await putSettings(env, uid, { vocab: [...vocab, t] });
    }
    await env.DB.prepare(`UPDATE vocab_suggestions SET status='added', updated_at=datetime('now') WHERE user_id=? AND term=?`).bind(uid, t).run();
    return getSettings(env, uid);
  }],

  ["POST", /^\/api\/vocab\/suggestions\/dismiss$/, async (req, env, _p, _u, _c, uid) => {
    const r = await env.DB.prepare(`UPDATE vocab_suggestions SET status='dismissed', updated_at=datetime('now') WHERE user_id=? AND term=?`).bind(uid, await term(req)).run();
    if (!r.meta.changes) throw new HttpError(404, "suggestion not found");
    return { ok: true };
  }],

  ["POST", /^\/api\/vocab\/scan$/, async (_req, env, _p, _u, _c, uid) => {
    if (await env.DB.prepare(`SELECT 1 FROM vocab_scans WHERE user_id=? AND status IN ('queued','running')`).bind(uid).first()) throw new HttpError(409, "已在分析中");
    const scan = await queueScan(env, uid, true);
    if (!scan) throw new HttpError(409, "沒有新的錄音可以分析");
    return scan;
  }],
];

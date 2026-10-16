// Export / import: move an account's finished recordings, people, folders, 問問看, settings and vocab between servers
// (docs/SPEC.md "Transfer"). The browser builds and reads the zip (public/zip.js, public/transfer.js); these routes hand
// it the data and write imported rows straight to done. Every route 404s unless TRANSFER_ENABLED=1.
import type { Route } from "./app";
import { type Env, type Handler, HttpError, first, parseParts, readJSON } from "./http";
import { DEFAULTS, parseSettings, putSettings } from "./settings";
import { EXPORT_FORMAT, EXPORT_VERSION, checkManifest, folderPlan, mapSources, mergeSettings, rewriteCitations, transferEnabled } from "./transfer-merge";
import { VOICE_MODEL } from "./voice";

const id = (s: string) => Number(s);
const PART_SIZE = 50 * 1024 * 1024; // as app.ts: the browser uploads play.m4a in parts of this size
const CHUNK_CHARS = 300_000; // as runner.ts: JSON chars per bound parameter (D1 caps a value at 2 MB)
type IdMap = Record<string, number>;
const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const ints = (m: unknown): IdMap => Object.fromEntries(Object.entries((m ?? {}) as Record<string, unknown>).filter(([, v]) => Number.isInteger(v)) as [string, number][]);

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [], n = 0;
  for (const it of items) {
    const len = JSON.stringify(it).length;
    if (cur.length && n + len > CHUNK_CHARS) out.push(cur), (cur = []), (n = 0);
    cur.push(it), (n += len);
  }
  if (cur.length) out.push(cur);
  return out;
}

// ids the client sends back from an earlier step are only trusted when they are this user's
async function ownIds(env: Env, table: "people" | "folders" | "recordings", uid: number) {
  const { results } = await env.DB.prepare(`SELECT id FROM ${table} WHERE user_id=?`).bind(uid).all<{ id: number }>();
  return new Set(results.map((r) => r.id));
}
const keepOwn = (map: IdMap, own: Set<number>): IdMap => Object.fromEntries(Object.entries(map).filter(([, v]) => own.has(v)));
const json = (v: string | null) => (v == null ? null : JSON.parse(v));
// what moves: finished recordings outside the trash (the zip carries their play.m4a)
const EXPORTABLE = `status='done' AND deleted_at IS NULL`;

const gate = (h: Handler): Handler => (req, env, p, url, ctx, uid) => {
  if (!transferEnabled(env)) throw new HttpError(404, "not found");
  return h(req, env, p, url, ctx, uid);
};

async function exportIndex(env: Env, uid: number, origin: string) {
  const db = env.DB;
  const [folders, people, prints, settings, vocab, asks, recs, left] = (await db.batch([
    db.prepare(`SELECT id, parent_id, name, created_at FROM folders WHERE user_id=? ORDER BY id`).bind(uid),
    db.prepare(`SELECT id, name, last_used_at FROM people WHERE user_id=? ORDER BY id`).bind(uid),
    db.prepare(`SELECT person_id, speaker_id, embedding, emb_model, created_at FROM voiceprints WHERE user_id=? ORDER BY id`).bind(uid),
    db.prepare(`SELECT key, value FROM settings WHERE user_id=?`).bind(uid),
    db.prepare(`SELECT term, misheard, kind, status FROM vocab_suggestions WHERE user_id=? AND status != 'new' ORDER BY term`).bind(uid),
    db.prepare(`SELECT id, question, answer_md, sources, created_at FROM asks WHERE user_id=? AND status='done' ORDER BY id`).bind(uid),
    db.prepare(`SELECT id, import_key, size, title FROM recordings WHERE user_id=? AND ${EXPORTABLE} ORDER BY created_at, id`).bind(uid),
    db.prepare(`SELECT id, title, status FROM recordings WHERE user_id=? AND deleted_at IS NULL AND status NOT IN ('done','importing') ORDER BY id`).bind(uid),
  ])).map((r) => r.results as Record<string, any>[]);
  return {
    manifest: { format: EXPORT_FORMAT, version: EXPORT_VERSION, exported_at: new Date().toISOString(), source: origin,
      export_id: crypto.randomUUID(), voice_model: VOICE_MODEL },
    folders,
    people: people.map((p) => ({ ...p, voiceprints: prints.filter((v) => v.person_id === p.id)
      .map((v) => ({ speaker_id: v.speaker_id, embedding: json(v.embedding), emb_model: v.emb_model, created_at: v.created_at })) })),
    settings: Object.fromEntries(settings.filter((r) => r.key in DEFAULTS).map((r) => [r.key, json(r.value)])),
    vocab: vocab.map((v) => ({ ...v, misheard: json(v.misheard) })),
    asks: asks.map((a) => ({ ...a, sources: json(a.sources) ?? [] })),
    // an imported recording keeps the key it came with, so moving it again still dedupes
    recordings: recs.map((r) => ({ ...r, import_key: r.import_key ?? `${origin}#${r.id}` })),
    left_out: left, // unfinished or failed: not exported, listed to the person
  };
}

async function exportRecording(env: Env, rid: number, uid: number, origin: string) {
  const db = env.DB;
  const recording = await first<Record<string, any>>(db.prepare(`SELECT id, import_key, title, filename, duration_s, created_at, folder_id, language
    FROM recordings WHERE id=? AND user_id=? AND ${EXPORTABLE}`).bind(rid, uid), "recording not found");
  const [speakers, segments, summaries] = (await db.batch([
    db.prepare(`SELECT id, label, display_name, person_id, auto, embedding, emb_model FROM speakers WHERE recording_id=? AND user_id=? ORDER BY id`).bind(rid, uid),
    db.prepare(`SELECT start_ms, end_ms, speaker_id, text_raw, text_clean FROM segments WHERE recording_id=? AND user_id=? ORDER BY start_ms, id`).bind(rid, uid),
    db.prepare(`SELECT template_id, language, content_md, created_at FROM summaries WHERE recording_id=? AND user_id=? AND status='done' ORDER BY id`).bind(rid, uid),
  ])).map((r) => r.results as Record<string, any>[]);
  return {
    recording: { ...recording, import_key: recording.import_key ?? `${origin}#${recording.id}` },
    speakers: speakers.map((s) => ({ ...s, embedding: json(s.embedding) })),
    segments, summaries,
  };
}

// ---- import, step 1: folders (by path), people (by name), settings (unset keys only), vocab decisions
async function importMeta(req: Request, env: Env, uid: number) {
  const b = await readJSON<{ manifest?: unknown; folders?: unknown; people?: unknown; settings?: unknown; vocab?: unknown }>(req);
  const bad = checkManifest(b.manifest);
  if (bad) throw new HttpError(400, bad);
  const db = env.DB;
  const folders: IdMap = {};
  const list = (Array.isArray(b.folders) ? b.folders : []).filter((f) => Number.isInteger(f?.id) && str(f?.name, 200)) as { id: number; parent_id: number | null; name: string }[];
  for (const f of folderPlan(list)) {
    const parent = f.parent_id == null ? null : folders[f.parent_id] ?? null;
    const hit = await db.prepare(`SELECT id FROM folders WHERE user_id=? AND coalesce(parent_id,0)=coalesce(?,0) AND name=?`).bind(uid, parent, f.name).first<{ id: number }>();
    folders[f.id] = hit?.id ?? (await first<{ id: number }>(db.prepare(`INSERT INTO folders(parent_id, name, user_id) VALUES(?, ?, ?) RETURNING id`).bind(parent, f.name, uid))).id;
  }
  const people: IdMap = {};
  for (const p of (Array.isArray(b.people) ? b.people : []) as { id: unknown; name: unknown; last_used_at: unknown }[]) {
    const name = str(p?.name, 100);
    if (!Number.isInteger(p?.id) || !name) continue;
    const used = typeof p.last_used_at === "string" ? p.last_used_at : null;
    people[p.id as number] = (await first<{ id: number }>(db.prepare(`INSERT INTO people(name, last_used_at, user_id) VALUES(?1, coalesce(?2, datetime('now')), ?3)
      ON CONFLICT(user_id, name) DO UPDATE SET last_used_at=max(last_used_at, coalesce(?2, last_used_at)) RETURNING id`).bind(name, used, uid))).id;
  }
  const { results: stored } = await db.prepare(`SELECT key, value FROM settings WHERE user_id=?`).bind(uid).all<{ key: string; value: string }>();
  const existing = Object.fromEntries(stored.map((r) => [r.key, JSON.parse(r.value)]));
  await putSettings(env, uid, mergeSettings(existing, (b.settings ?? {}) as Record<string, unknown>, people, parseSettings));
  const decided = (Array.isArray(b.vocab) ? b.vocab : []).filter((v) => str(v?.term, 50) && ["added", "dismissed"].includes(v?.status));
  if (decided.length) await db.batch(decided.map((v) => db.prepare(`INSERT INTO vocab_suggestions(user_id, term, misheard, kind, status) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(user_id, term) DO NOTHING`).bind(uid, v.term, JSON.stringify(Array.isArray(v.misheard) ? v.misheard : []), typeof v.kind === "string" ? v.kind : null, v.status)));
  return { folders, people };
}

type Speaker = { id: number; label: string; display_name: string; person_id: number | null; auto: number; embedding: number[] | null; emb_model: string | null };

// ---- import, step 2: one recording's rows (status 'importing') + an R2 multipart upload for its play.m4a
async function importRecording(req: Request, env: Env, uid: number) {
  const b = await readJSON<{ recording?: any; speakers?: unknown; segments?: unknown; summaries?: unknown; folder_id?: unknown; people?: unknown;
    voiceprints?: unknown; size?: unknown }>(req);
  const r = b.recording ?? {};
  const key = str(r.import_key, 500), title = str(r.title, 500);
  if (!key || !title) throw new HttpError(400, "recording.import_key and recording.title required");
  if (!Number.isInteger(b.size) || (b.size as number) < 0) throw new HttpError(400, "size required");
  const db = env.DB;
  const prior = await db.prepare(`SELECT id, status, source_key, play_key, upload_id FROM recordings WHERE user_id=? AND import_key=?`).bind(uid, key)
    .first<{ id: number; status: string; source_key: string | null; play_key: string | null; upload_id: string | null }>();
  if (prior?.status === "done") return { skipped: true, recording_id: prior.id };
  if (prior) { // an earlier import stopped half way: start this one over
    if (prior.upload_id && prior.source_key) await env.AUDIO.resumeMultipartUpload(prior.source_key, prior.upload_id).abort().catch(() => {});
    const keys = [prior.source_key, prior.play_key].filter((k): k is string => !!k);
    if (keys.length) await env.AUDIO.delete(keys);
    await db.prepare(`DELETE FROM recordings WHERE id=? AND user_id=?`).bind(prior.id, uid).run();
  }
  const folder = Number.isInteger(b.folder_id) && (await ownIds(env, "folders", uid)).has(b.folder_id as number) ? (b.folder_id as number) : null;
  const ownPeople = await ownIds(env, "people", uid);
  const people = keepOwn(ints(b.people), ownPeople); // old person id → this account's person (from step 1)
  const lang = ["zh", "en", "ja", "auto"].includes(r.language) ? r.language : null;
  const { id: rid } = await first<{ id: number }>(db.prepare(`INSERT INTO recordings(title, filename, duration_s, created_at, folder_id, language, status, import_key, size, user_id)
    VALUES(?, ?, ?, coalesce(?, datetime('now')), ?, ?, 'importing', ?, ?, ?) RETURNING id`)
    .bind(title, str(r.filename, 500) ?? title, typeof r.duration_s === "number" ? r.duration_s : null, typeof r.created_at === "string" ? r.created_at : null,
      folder, lang, key, b.size, uid));
  try {
    const speakers = (Array.isArray(b.speakers) ? b.speakers : []).filter((s) => Number.isInteger(s?.id)) as Speaker[];
    const sp = speakers.map((s) => ({ label: String(s.label ?? ""), display_name: String(s.display_name ?? ""), person_id: s.person_id == null ? null : people[s.person_id] ?? null,
      auto: [0, 1, 2].includes(s.auto) ? s.auto : 0, embedding: Array.isArray(s.embedding) ? s.embedding : null, emb_model: typeof s.emb_model === "string" ? s.emb_model : null }));
    const inserted = sp.length ? (await db.prepare(`INSERT INTO speakers(recording_id, label, display_name, person_id, auto, embedding, emb_model, user_id)
      SELECT ?1, value->>'label', value->>'display_name', value->>'person_id', value->>'auto', nullif(value->'embedding', 'null'), value->>'emb_model', ?3
      FROM json_each(?2) ORDER BY key RETURNING id`).bind(rid, JSON.stringify(sp), uid).all<{ id: number }>()).results.map((x) => x.id).sort((x, y) => x - y) : [];
    const speakerMap: IdMap = Object.fromEntries(speakers.map((s, i) => [s.id, inserted[i]]));
    const segs = (Array.isArray(b.segments) ? b.segments : []).filter((g) => Number.isFinite(g?.start_ms) && Number.isFinite(g?.end_ms) && typeof g?.text_raw === "string")
      .map((g) => [Math.round(g.start_ms), Math.round(g.end_ms), g.speaker_id == null ? null : speakerMap[g.speaker_id] ?? null, g.text_raw, typeof g.text_clean === "string" ? g.text_clean : null]);
    const sums = (Array.isArray(b.summaries) ? b.summaries : []).filter((x) => typeof x?.content_md === "string" && typeof x?.template_id === "string");
    // voiceprints arrive with the new person id (the client mapped it) and the old speaker id
    const prints = (Array.isArray(b.voiceprints) ? b.voiceprints : []).filter((v) => speakerMap[v?.speaker_id] && ownPeople.has(v?.person_id) && Array.isArray(v?.embedding));
    const rows = [
      ...chunks(segs).map((c) => db.prepare(`INSERT INTO segments(recording_id, start_ms, end_ms, speaker_id, text_raw, text_clean, user_id)
        SELECT ?1, value->>0, value->>1, value->>2, value->>3, value->>4, ?3 FROM json_each(?2) ORDER BY key`).bind(rid, JSON.stringify(c), uid)),
      ...sums.map((x) => db.prepare(`INSERT INTO summaries(recording_id, template_id, language, status, content_md, created_at, user_id)
        VALUES(?, ?, ?, 'done', ?, coalesce(?, datetime('now')), ?)`).bind(rid, x.template_id, typeof x.language === "string" ? x.language : null, x.content_md,
        typeof x.created_at === "string" ? x.created_at : null, uid)),
      ...prints.map((v) => db.prepare(`INSERT INTO voiceprints(person_id, speaker_id, embedding, emb_model, user_id) VALUES(?, ?, ?, ?, ?)`)
        .bind(v.person_id, speakerMap[v.speaker_id], JSON.stringify(v.embedding), typeof v.emb_model === "string" ? v.emb_model : VOICE_MODEL, uid)),
    ];
    if (rows.length) await db.batch(rows); // D1 rejects an empty batch
    const path = `u/${uid}/rec/${rid}/play.m4a`;
    const up = await env.AUDIO.createMultipartUpload(path, { httpMetadata: { contentType: "audio/mp4" } });
    await db.prepare(`UPDATE recordings SET source_key=?, upload_id=? WHERE id=? AND user_id=?`).bind(path, up.uploadId, rid, uid).run();
  } catch (e) {
    await db.prepare(`DELETE FROM recordings WHERE id=? AND user_id=?`).bind(rid, uid).run();
    throw e;
  }
  return { recording_id: rid, part_size: PART_SIZE };
}

// ---- import, step 3: the audio is up → done (never queued: no runner, no Cloud charge)
async function completeImport(req: Request, env: Env, rid: number, uid: number) {
  const parts = parseParts(await readJSON(req));
  const rec = await first<{ status: string; source_key: string | null; upload_id: string | null }>(
    env.DB.prepare(`SELECT status, source_key, upload_id FROM recordings WHERE id=? AND user_id=?`).bind(rid, uid), "recording not found");
  if (rec.status !== "importing" || !rec.source_key || !rec.upload_id) throw new HttpError(409, "not an import in progress");
  const obj = await env.AUDIO.resumeMultipartUpload(rec.source_key, rec.upload_id).complete(parts);
  await env.DB.prepare(`UPDATE recordings SET play_key=source_key, source_key=NULL, upload_id=NULL, size=?, status='done' WHERE id=? AND user_id=?`)
    .bind(obj.size, rid, uid).run();
  return { ok: true, recording_id: rid };
}

// ---- import, step 4: 問問看 with sources and [[id@mm:ss]] citations pointed at the new recordings
async function importAsks(req: Request, env: Env, uid: number) {
  const b = await readJSON<{ asks?: unknown; recordings?: unknown }>(req);
  const map = keepOwn(ints(b.recordings), await ownIds(env, "recordings", uid));
  const asks = (Array.isArray(b.asks) ? b.asks : []).filter((a) => str(a?.question, 1000));
  // the same ask (question + time) already here = an earlier import of this zip: skip it
  if (asks.length) await env.DB.batch(asks.map((a) => env.DB.prepare(`INSERT INTO asks(question, answer_md, sources, status, created_at, user_id)
    SELECT ?1, ?2, ?3, 'done', coalesce(?4, datetime('now')), ?5
    WHERE NOT EXISTS(SELECT 1 FROM asks WHERE user_id=?5 AND question=?1 AND created_at=?4)`).bind(a.question, typeof a.answer_md === "string" ? rewriteCitations(a.answer_md, map) : null,
    JSON.stringify(mapSources(Array.isArray(a.sources) ? a.sources.filter(Number.isInteger) : [], map)), typeof a.created_at === "string" ? a.created_at : null, uid)));
  return { imported: asks.length };
}

export const transferRoutes: Route[] = [
  ["GET", /^\/api\/export$/, gate((_req, env, _p, url, _c, uid) => exportIndex(env, uid, url.origin))],
  ["GET", /^\/api\/export\/recordings\/(\d+)$/, gate((_req, env, [rid], url, _c, uid) => exportRecording(env, id(rid), uid, url.origin))],
  ["POST", /^\/api\/import\/meta$/, gate((req, env, _p, _u, _c, uid) => importMeta(req, env, uid))],
  ["POST", /^\/api\/import\/recordings$/, gate((req, env, _p, _u, _c, uid) => importRecording(req, env, uid))],
  ["POST", /^\/api\/import\/recordings\/(\d+)\/complete$/, gate((req, env, [rid], _u, _c, uid) => completeImport(req, env, id(rid), uid))],
  ["POST", /^\/api\/import\/asks$/, gate((req, env, _p, _u, _c, uid) => importAsks(req, env, uid))],
];

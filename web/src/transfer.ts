// Export / import: move an account's finished recordings, people, folders, 問問看, settings and vocab between servers
// (docs/SPEC.md "Transfer"). The browser builds and reads the zip (public/zip.js, public/transfer.js); these routes hand
// it the data and write imported rows straight to done. Every route 404s unless TRANSFER_ENABLED=1.
import type { Route } from "./app";
import { type Env, type Handler, HttpError, first } from "./http";
import { DEFAULTS } from "./settings";
import { EXPORT_FORMAT, EXPORT_VERSION, transferEnabled } from "./transfer-merge";
import { VOICE_MODEL } from "./voice";

const id = (s: string) => Number(s);
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

export const transferRoutes: Route[] = [
  ["GET", /^\/api\/export$/, gate((_req, env, _p, url, _c, uid) => exportIndex(env, uid, url.origin))],
  ["GET", /^\/api\/export\/recordings\/(\d+)$/, gate((_req, env, [rid], url, _c, uid) => exportRecording(env, id(rid), uid, url.origin))],
];

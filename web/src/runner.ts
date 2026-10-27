// Runner job API: jobs are claimed with a lease; a lease that expires makes the job claimable again.
// Runners are shared across users: claims are global (oldest first) and every route acts on the job row's user_id.
// ponytail: no per-user fairness; one heavy user can delay others until Phase 2 queues.
import { type Env, type Handler, HttpError, first, parseParts, partNumber, readJSON, runnerName, serveR2, splitFilename, retryIdempotent } from "./http";
import { notifyJob } from "./push";
import { getSettings } from "./settings";
import { parseTerms, queueScan, saveTerms, scanCandidates, scanJob } from "./vocab";
import { LEGACY_MODEL, VOICE_MODEL, enrol, isDefaultName, isEmbModel, isEmbedding, rematch } from "./voice";

const LEASE = `datetime('now','+10 minutes')`;
const ACTIVE = { recordings: `status IN ('converting','transcribing','cleaning')`, summaries: `status='running'`, asks: `status='running'`, vocab_scans: `status='running'` };
const CHUNK_CHARS = 300_000; // JSON chars per bound parameter; D1 caps a value at 2 MB (CJK = 3 bytes/char)
// ponytail: dates handed to the Ask LLM are Taiwan local; add a timezone setting if the user ever moves
const TZ = `'+8 hours'`;
const ASK_INDEX_LIMIT = 1000; // Ask LLM sees the most recent N done recordings to limit memory usage

type Kind = keyof typeof ACTIVE;
const kindOf = (s: string): Kind =>
  (s.startsWith("rec") ? "recordings" : s.startsWith("ask") ? "asks" : s.startsWith("vocab") ? "vocab_scans" : "summaries");
const id = (s: string) => Number(s);

// Records that a runner is alive; stt and build version are only known on claim.
const str = (v: unknown, max = 64) => (typeof v === "string" && v ? v.slice(0, max) : null);
const seen = (env: Env, runner: string, info: { stt?: unknown; version?: unknown; version_time?: unknown } = {}) =>
  env.DB.prepare(`INSERT INTO runners(name, stt, version, version_time) VALUES(?1, ?2, ?3, ?4)
    ON CONFLICT(name) DO UPDATE SET last_seen=datetime('now'), stt=coalesce(?2, stt),
      version=coalesce(?3, version), version_time=coalesce(?4, version_time)`)
    .bind(runner, str(info.stt), str(info.version), str(info.version_time));

// Extends the lease if this runner still holds the job; otherwise the runner must abort.
async function hold(env: Env, kind: Kind, jid: number, runner: string, status: string | null = null) {
  const [r] = await env.DB.batch([
    env.DB.prepare(`UPDATE ${kind} SET lease_until=${LEASE}, status=coalesce(?3, status)
      WHERE id=?1 AND runner=?2 AND ${ACTIVE[kind]}`).bind(jid, runner, status),
    seen(env, runner),
  ]);
  if (!r.meta.changes) throw new HttpError(409, "lease lost");
}

// Online = contacted within 3 min (idle runners poll every 10 s, busy ones heartbeat every 60 s).
// Jobs and queue counts are the caller's own.
export async function listRunners(env: Env, uid: number) {
  const { results } = await retryIdempotent(() =>
    env.DB.prepare(`SELECT r.name, r.last_seen, r.stt, r.version, r.version_time,
      CAST(strftime('%s','now') - strftime('%s', r.last_seen) AS INTEGER) AS ago_s,
      coalesce(
        (SELECT json_object('kind','recording','id',id,'status',status,'title',title) FROM recordings
          WHERE runner=r.name AND user_id=?1 AND ${ACTIVE.recordings} AND lease_until > datetime('now') LIMIT 1),
        (SELECT json_object('kind','summary','id',s.id,'recording_id',s.recording_id,'status',s.status,'title',rc.title)
          FROM summaries s JOIN recordings rc ON rc.id=s.recording_id
          WHERE s.runner=r.name AND s.user_id=?1 AND s.${ACTIVE.summaries} AND s.lease_until > datetime('now') LIMIT 1),
        (SELECT json_object('kind','ask','id',id,'status',status,'title',question) FROM asks
          WHERE runner=r.name AND user_id=?1 AND ${ACTIVE.asks} AND lease_until > datetime('now') LIMIT 1),
        (SELECT json_object('kind','vocab','id',id,'status',status) FROM vocab_scans
          WHERE runner=r.name AND user_id=?1 AND ${ACTIVE.vocab_scans} AND lease_until > datetime('now') LIMIT 1)) AS job
    FROM runners r ORDER BY r.last_seen DESC`).bind(uid).all<{ name: string; last_seen: string; stt: string | null; version: string | null; version_time: string | null; ago_s: number; job: string | null }>()
  );
  const q = await retryIdempotent(() =>
    env.DB.prepare(`SELECT
      (SELECT count(*) FROM recordings WHERE user_id=?1 AND status='queued' AND deleted_at IS NULL) AS recordings,
      (SELECT count(*) FROM summaries WHERE user_id=?1 AND status='queued') AS summaries,
      (SELECT count(*) FROM asks WHERE user_id=?1 AND status='queued') AS asks,
      (SELECT count(*) FROM vocab_scans WHERE user_id=?1 AND status='queued') AS vocab`).bind(uid).first<{ recordings: number; summaries: number; asks: number; vocab: number }>()
  );
  const runners = results.map((r) => ({ ...r, online: r.ago_s < 180, job: r.job ? JSON.parse(r.job) : null }));
  return { runners, queued: q ?? { recordings: 0, summaries: 0, asks: 0, vocab: 0 } };
}

// play.m4a uploads carry the runner in ?runner= (the PUT body is raw audio).
const holdQuery = (env: Env, rid: number, url: URL) => hold(env, "recordings", rid, runnerName({ runner: url.searchParams.get("runner") }));

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let n = 0;
  for (const it of items) {
    const len = JSON.stringify(it).length;
    if (cur.length && n + len > CHUNK_CHARS) out.push(cur), (cur = []), (n = 0);
    cur.push(it), (n += len);
  }
  if (cur.length) out.push(cur);
  return out;
}

async function transcriptText(env: Env, rid: number) {
  const BATCH_SIZE = 2000;
  const pad = (n: number) => String(n).padStart(2, "0");
  const lines: string[] = [];
  let lastStartMs = -1;
  let lastId = -1;
  while (true) {
    const { results } = await retryIdempotent(() =>
      env.DB.prepare(`SELECT s.start_ms AS ms, s.id, coalesce(sp.display_name, 'Speaker') AS name, coalesce(s.text_clean, s.text_raw) AS text
        FROM segments s LEFT JOIN speakers sp ON sp.id = s.speaker_id
        WHERE s.recording_id=? AND (s.start_ms > ? OR (s.start_ms = ? AND s.id > ?))
        ORDER BY s.start_ms, s.id LIMIT ?`)
        .bind(rid, lastStartMs, lastStartMs, lastId, BATCH_SIZE)
        .all<{ ms: number; id: number; name: string; text: string }>()
    );
    if (!results.length) break;
    for (const r of results) {
      lines.push(`[${pad(Math.floor(r.ms / 60000))}:${pad(Math.floor(r.ms / 1000) % 60)}] ${r.name}: ${r.text}`);
      lastStartMs = r.ms;
      lastId = r.id;
    }
    if (results.length < BATCH_SIZE) break;
  }
  return lines.join("\n");
}

// Ask step 1: one compact line per done recording of the asker; speakers = names that have segments, summary = start of the newest one.
async function askIndex(env: Env, uid: number) {
  const { results: recordings } = await retryIdempotent(() =>
    env.DB.prepare(`SELECT r.id, r.title, date(r.created_at, ${TZ}) AS date, r.duration_s,
      (SELECT substr(content_md, 1, 300) FROM summaries WHERE recording_id=r.id AND status='done' ORDER BY id DESC LIMIT 1) AS summary
    FROM recordings r WHERE r.user_id=? AND r.deleted_at IS NULL AND r.status='done'
    ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
      .bind(uid, ASK_INDEX_LIMIT)
      .all<{ id: number; title: string; date: string; duration_s: number | null; summary: string | null }>()
  );
  if (!recordings.length) return [];
  const ids = recordings.map((r) => r.id);
  const { results: speakers } = await retryIdempotent(() =>
    env.DB.prepare(`SELECT s.recording_id, json_group_array(DISTINCT sp.display_name) AS names
      FROM segments s JOIN speakers sp ON sp.id = s.speaker_id
      WHERE s.recording_id IN (SELECT value FROM json_each(?))
      GROUP BY s.recording_id`)
      .bind(JSON.stringify(ids))
      .all<{ recording_id: number; names: string }>()
  );
  const speakerMap = new Map(speakers.map((s) => [s.recording_id, JSON.parse(s.names) as string[]]));
  return recordings.map((r) => ({ ...r, speakers: speakerMap.get(r.id) ?? [] }));
}

// An existing (or lease-expired) scan, else a new one if one is due (queueScan).
async function claimVocab(env: Env, runner: string) {
  const claim = () => retryIdempotent(() =>
    env.DB.prepare(`UPDATE vocab_scans SET status='running', runner=?1, lease_until=${LEASE}, error=NULL
      WHERE id=(SELECT id FROM vocab_scans WHERE status='queued' OR (${ACTIVE.vocab_scans} AND (lease_until < datetime('now') OR runner=?1)) ORDER BY id LIMIT 1)
      RETURNING id, from_id, to_id, user_id`).bind(runner).first<{ id: number; from_id: number; to_id: number; user_id: number }>()
  );
  let scan = await claim();
  // queueScan itself is idempotent (INSERT with NOT EXISTS guard), but the outer loop over scanCandidates is not
  // (candidates are randomized, and retrying would attempt different users). Not wrapped in retryIdempotent.
  for (const uid of scan ? [] : await scanCandidates(env)) if (await queueScan(env, uid, false)) { scan = await claim(); break; }
  return scan ? scanJob(env, scan) : null;
}

async function recording(env: Env, rid: number) {
  return first<{ filename: string; source_key: string | null; play_key: string | null; upload_id: string | null; user_id: number }>(
    env.DB.prepare(`SELECT filename, source_key, play_key, upload_id, user_id FROM recordings WHERE id=?`).bind(rid));
}

const playKey = (rec: { user_id: number }, rid: number) => `u/${rec.user_id}/rec/${rid}/play.m4a`;

export const runnerRoutes: [string, RegExp, Handler][] = [
  // Claims are idempotent: UPDATE…RETURNING claim is atomic in D1, and `runner=?1` ensures that a retry by the same
  // runner always gets the same row back (until the lease expires ≤10 min later). Two different runners can never
  // claim the same job, even when `ORDER BY id` skips a row; at most a job is delayed ~10 min, never double-processed.
  ["POST", /^\/api\/runner\/claim$/, async (req, env) => {
    let stage: string = "init";
    try {
      const body = await readJSON<{ runner?: unknown; stt?: unknown; version?: unknown; version_time?: unknown; skip_recordings?: unknown; asks?: unknown; vocab?: unknown }>(req);
      const runner = runnerName(body);
      stage = "seen";
      await retryIdempotent(() => seen(env, runner, body).run());
      // asks first (interactive, short); only runners that declare `asks: true` know the job kind
      stage = "ask";
      const ask = body.asks !== true ? null : await retryIdempotent(() =>
        env.DB.prepare(`UPDATE asks SET status='running', runner=?1, lease_until=${LEASE}, error=NULL
          WHERE id=(SELECT id FROM asks WHERE status='queued' OR (${ACTIVE.asks} AND (lease_until < datetime('now') OR runner=?1)) ORDER BY id LIMIT 1)
          RETURNING id, question, user_id`).bind(runner).first<{ id: number; question: string; user_id: number }>()
      );
      if (ask) {
        const { user_id, ...job } = ask;
        const { today } = (await retryIdempotent(() => env.DB.prepare(`SELECT date('now', ${TZ}) AS today`).first<{ today: string }>()))!;
        stage = "askIndex";
        return { job: { kind: "ask", ...job, today, index: await askIndex(env, user_id) } };
      }
      // a runner works one job at a time, so a job still leased to this runner is left over from its previous run
      // one UPDATE…RETURNING per table: D1 runs statements serially, so two runners can never get the same row
      // skip_recordings: the runner's STT is paused (Groq quota), so it only takes summaries for now
      stage = "rec";
      const rec = body.skip_recordings === true ? null : await retryIdempotent(() =>
        env.DB.prepare(`UPDATE recordings
          SET status='converting', runner=?1, lease_until=${LEASE}, error=NULL, not_before=NULL, note=NULL
          WHERE id=(SELECT id FROM recordings WHERE deleted_at IS NULL
            AND ((status='queued' AND (not_before IS NULL OR not_before <= datetime('now')))
              OR (${ACTIVE.recordings} AND (lease_until < datetime('now') OR runner=?1))) ORDER BY id LIMIT 1)
          RETURNING id, filename, size, source_key, play_key, language, user_id`).bind(runner)
          .first<{ id: number; filename: string; size: number | null; source_key: string | null; play_key: string | null; language: string | null; user_id: number }>()
      );
      if (rec) {
        // retranscribe after the source was deleted: the runner gets play.m4a as its source
        const playKey = rec.play_key;
        const size = rec.source_key ? rec.size : playKey ? (await retryIdempotent(() => env.AUDIO.head(playKey)))?.size ?? null : null;
        const { stt_lang, cleanup, vocab } = await retryIdempotent(() => getSettings(env, rec.user_id));
        return { job: { kind: "recording", id: rec.id, filename: rec.filename, source_size: size, language: rec.language ?? stt_lang, settings: { cleanup, vocab } } };
      }
      stage = "sum";
      const sum = await retryIdempotent(() =>
        env.DB.prepare(`UPDATE summaries SET status='running', runner=?1, lease_until=${LEASE}, error=NULL
          WHERE id=(SELECT id FROM summaries WHERE status='queued' OR (${ACTIVE.summaries} AND (lease_until < datetime('now') OR runner=?1)) ORDER BY id LIMIT 1)
          RETURNING id, recording_id, template_id, language, user_id`).bind(runner)
          .first<{ id: number; recording_id: number; template_id: string; language: string; user_id: number }>()
      );
      // vocab scans last (background); only runners that declare `vocab: true` know the kind
      stage = "vocab";
      if (!sum) return { job: body.vocab === true ? await claimVocab(env, runner) : null };
      const { user_id, ...job } = sum;
      const { about, content_focus, instructions, me, vocab } = await retryIdempotent(() => getSettings(env, user_id));
      const meName = me === null ? null : (await retryIdempotent(() => env.DB.prepare(`SELECT name FROM people WHERE id=? AND user_id=?`).bind(me, user_id).first<{ name: string }>()))?.name ?? null;
      stage = "transcript";
      return { job: { kind: "summary", ...job, transcript: await transcriptText(env, sum.recording_id),
        settings: { about, content_focus, instructions, me: meName, vocab } } };
    } catch (e) {
      console.error("POST /api/runner/claim", `stage=${stage}`, e);
      if (e instanceof HttpError) throw e;
      const msg = String((e as Error)?.message ?? e);
      throw new Error(`${msg} stage=${stage}`);
    }
  }],

  ["POST", /^\/api\/runner\/(recordings?|summar(?:y|ies)|asks?|vocab)\/(\d+)\/heartbeat$/, async (req, env, [k, jid]) => {
    const body = await readJSON<{ runner?: unknown; status?: unknown }>(req);
    const kind = kindOf(k);
    let status: string | null = null;
    if (kind === "recordings" && body.status !== undefined && body.status !== null) {
      if (!["converting", "transcribing", "cleaning"].includes(body.status as string)) throw new HttpError(400, "status must be converting|transcribing|cleaning");
      status = body.status as string;
    }
    await hold(env, kind, id(jid), runnerName(body), status);
    return { ok: true };
  }],

  ["GET", /^\/api\/runner\/recordings\/(\d+)\/source$/, async (req, env, [rid]) => {
    const rec = await recording(env, id(rid));
    const key = rec.source_key ?? rec.play_key;
    if (!key) throw new HttpError(404, "source not found");
    return serveR2(req, env.AUDIO, key);
  }],

  ["PUT", /^\/api\/runner\/recordings\/(\d+)\/play$/, async (req, env, [rid], url) => {
    await holdQuery(env, id(rid), url);
    const rec = await recording(env, id(rid));
    if (!req.body) throw new HttpError(400, "empty body");
    const key = playKey(rec, id(rid));
    if (url.searchParams.has("part")) {
      if (!rec.upload_id) throw new HttpError(409, "no play upload started");
      const p = await env.AUDIO.resumeMultipartUpload(key, rec.upload_id).uploadPart(partNumber(url.searchParams.get("part")), req.body);
      return { etag: p.etag };
    }
    if (!req.headers.get("Content-Length")) throw new HttpError(411, "Content-Length required");
    await env.AUDIO.put(key, req.body, { httpMetadata: { contentType: "audio/mp4" } });
    await env.DB.prepare(`UPDATE recordings SET play_key=? WHERE id=?`).bind(key, id(rid)).run();
    if (rec.play_key && rec.play_key !== key) await env.AUDIO.delete(rec.play_key); // pre-0011 key layout
    return { ok: true };
  }],

  ["POST", /^\/api\/runner\/recordings\/(\d+)\/play\/start$/, async (_req, env, [rid], url) => {
    await holdQuery(env, id(rid), url);
    const up = await env.AUDIO.createMultipartUpload(playKey(await recording(env, id(rid)), id(rid)), { httpMetadata: { contentType: "audio/mp4" } });
    await env.DB.prepare(`UPDATE recordings SET upload_id=? WHERE id=?`).bind(up.uploadId, id(rid)).run();
    return { ok: true };
  }],

  ["POST", /^\/api\/runner\/recordings\/(\d+)\/play\/complete$/, async (req, env, [rid], url) => {
    const parts = parseParts(await readJSON(req));
    await holdQuery(env, id(rid), url);
    const rec = await recording(env, id(rid));
    if (!rec.upload_id) throw new HttpError(409, "no play upload started");
    const key = playKey(rec, id(rid));
    await env.AUDIO.resumeMultipartUpload(key, rec.upload_id).complete(parts);
    await env.DB.prepare(`UPDATE recordings SET play_key=?, upload_id=NULL WHERE id=?`).bind(key, id(rid)).run();
    if (rec.play_key && rec.play_key !== key) await env.AUDIO.delete(rec.play_key); // pre-0011 key layout
    return { ok: true };
  }],

  ["POST", /^\/api\/runner\/recordings\/(\d+)\/transcript$/, async (req, env, [rs]) => {
    const rid = id(rs);
    const body = await readJSON<{ runner?: unknown; duration_s?: unknown; speakers?: unknown; segments?: unknown }>(req);
    const speakers = body.speakers ?? [];
    const segments = body.segments ?? [];
    if (!Array.isArray(speakers) || !speakers.every((s) => typeof s?.label === "string" && typeof s?.display_name === "string"
      && (s.embedding == null || isEmbedding(s.embedding)) && isEmbModel(s.emb_model)))
      throw new HttpError(400, "speakers: [{label, display_name, embedding?: number[≤1024], emb_model?: string}] required");
    if (!Array.isArray(segments) || !segments.every((s) => Number.isFinite(s?.start_ms) && Number.isFinite(s?.end_ms) && typeof s?.text_raw === "string"))
      throw new HttpError(400, "segments: [{start_ms, end_ms, speaker, text_raw}] required");
    await hold(env, "recordings", rid, runnerName(body));
    const { user_id: uid } = await recording(env, rid);
    const db = env.DB;
    // one batch = one transaction; segments go in as JSON chunks, speaker index → id via the speakers just inserted
    const results = await db.batch([
      db.prepare(`DELETE FROM segments WHERE recording_id=?`).bind(rid),
      db.prepare(`DELETE FROM speakers WHERE recording_id=?`).bind(rid),
      db.prepare(`UPDATE recordings SET duration_s=? WHERE id=?`).bind(typeof body.duration_s === "number" ? body.duration_s : null, rid),
      db.prepare(`INSERT INTO speakers(recording_id, label, display_name, embedding, emb_model, user_id)
        SELECT ?1, value->>'label', value->>'display_name', nullif(value->'embedding', 'null'), value->>'emb_model', ?3 FROM json_each(?2) ORDER BY key`)
        .bind(rid, JSON.stringify(speakers.map((s) => ({ label: s.label, display_name: s.display_name,
          embedding: s.embedding ?? null, emb_model: s.embedding == null ? null : s.emb_model ?? LEGACY_MODEL }))), uid),
      ...chunks(segments.map((s) => [Math.round(s.start_ms), Math.round(s.end_ms), Number.isInteger(s.speaker) ? s.speaker : null, s.text_raw])).map((c) =>
        db.prepare(`WITH sp AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS idx FROM speakers WHERE recording_id=?1)
          INSERT INTO segments(recording_id, start_ms, end_ms, speaker_id, text_raw, user_id)
          SELECT ?1, value->>0, value->>1, (SELECT id FROM sp WHERE idx = value->>2), value->>3, ?3 FROM json_each(?2) ORDER BY key
          RETURNING id`).bind(rid, JSON.stringify(c), uid)),
    ]);
    // AUTOINCREMENT ids ascend in insertion order, which is input order
    const ids = results.slice(4).flatMap((r) => (r.results as { id: number }[]).map((x) => x.id)).sort((a, b) => a - b);
    await rematch(env, uid, rid);
    return { segment_ids: ids };
  }],

  // Voiceprint backfill (no lease): store embeddings, enrol this recording's named speakers, re-match everything.
  ["POST", /^\/api\/runner\/recordings\/(\d+)\/speaker-embeddings$/, async (req, env, [rs]) => {
    const rid = id(rs);
    const body = await readJSON<{ speakers?: unknown }>(req);
    const items = body.speakers;
    if (!Array.isArray(items) || !items.every((s) => Number.isInteger(s?.id) && isEmbedding(s.embedding) && isEmbModel(s.emb_model)))
      throw new HttpError(400, "speakers: [{id, embedding: number[≤1024], emb_model?: string}] required");
    const { user_id: uid } = await recording(env, rid);
    const db = env.DB;
    // never replace a VOICE_MODEL embedding with another model's (an old runner's backfill)
    const stored = items.length ? (await db.batch(items.map((s) =>
      db.prepare(`UPDATE speakers SET embedding=?1, emb_model=?2 WHERE id=?3 AND recording_id=?4 AND (emb_model IS NOT ?5 OR ?2 = ?5)`)
        .bind(JSON.stringify(s.embedding), s.emb_model ?? LEGACY_MODEL, s.id, rid, VOICE_MODEL))))
      .reduce((n, r) => n + r.meta.changes, 0) : 0;
    const { results } = await db.prepare(`SELECT id, display_name FROM speakers WHERE recording_id=? AND auto=0 AND label<>'custom' AND embedding IS NOT NULL`)
      .bind(rid).all<{ id: number; display_name: string }>();
    const named = results.filter((s) => !isDefaultName(s.display_name));
    if (named.length) await db.batch(named.flatMap((s) => enrol(db, uid, s.id, s.display_name, true)));
    return { stored, enrolled: named.length, relabelled: await rematch(env, uid) };
  }],

  ["POST", /^\/api\/runner\/recordings\/(\d+)\/clean$/, async (req, env, [rs]) => {
    const rid = id(rs);
    const body = await readJSON<{ runner?: unknown; items?: unknown; title?: unknown }>(req);
    const items = body.items ?? [];
    if (!Array.isArray(items) || !items.every((i) => Number.isInteger(i?.id) && typeof i?.text_clean === "string"))
      throw new HttpError(400, "items: [{id, text_clean}] required");
    await hold(env, "recordings", rid, runnerName(body));
    const stmts = chunks(items.map((i) => ({ id: i.id, text_clean: i.text_clean }))).map((c) =>
      env.DB.prepare(`UPDATE segments SET text_clean = j.value->>'text_clean' FROM json_each(?2) j
        WHERE +segments.recording_id=?1 AND segments.id = j.value->>'id'`).bind(rid, JSON.stringify(c)));
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title) {
      const { stem } = splitFilename((await recording(env, rid)).filename);
      stmts.push(env.DB.prepare(`UPDATE recordings SET title=? WHERE id=? AND title=?`).bind(title, rid, stem));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return { ok: true };
  }],

  ["POST", /^\/api\/runner\/recordings\/(\d+)\/done$/, async (req, env, [rs], _url, ctx) => {
    const rid = id(rs);
    const runner = runnerName(await readJSON(req));
    const { source_key } = await recording(env, rid);
    const r = await env.DB.prepare(`UPDATE recordings SET status='done', error=NULL, lease_until=NULL, source_key=NULL
      WHERE id=?1 AND runner=?2 AND ${ACTIVE.recordings}`).bind(rid, runner).run();
    if (!r.meta.changes) throw new HttpError(409, "lease lost");
    if (source_key) await env.AUDIO.delete(source_key);
    ctx.waitUntil(notifyJob(env, "recordings", rid, "逐字稿完成"));
    return { ok: true };
  }],

  // Puts a claimed recording back in the queue until `seconds` from now (e.g. Groq quota), with a note for the UI.
  ["POST", /^\/api\/runner\/recordings?\/(\d+)\/defer$/, async (req, env, [rid]) => {
    const body = await readJSON<{ runner?: unknown; seconds?: unknown; note?: unknown }>(req);
    const secs = Math.min(Math.max(Math.round(Number(body.seconds) || 0), 0), 86_400);
    const r = await env.DB.prepare(`UPDATE recordings SET status='queued', runner=NULL, lease_until=NULL,
        not_before=datetime('now', '+' || ?3 || ' seconds'), note=?4
      WHERE id=?1 AND runner=?2 AND ${ACTIVE.recordings}`).bind(id(rid), runnerName(body), secs, String(body.note ?? "").slice(0, 200) || null).run();
    if (!r.meta.changes) throw new HttpError(409, "lease lost");
    return { ok: true };
  }],

  // Puts a claimed summary, ask or vocab scan straight back in the queue (runner shutting down).
  ["POST", /^\/api\/runner\/(summar(?:y|ies)|asks?|vocab)\/(\d+)\/defer$/, async (req, env, [k, jid]) => {
    const kind = kindOf(k);
    const r = await env.DB.prepare(`UPDATE ${kind} SET status='queued', runner=NULL, lease_until=NULL
      WHERE id=?1 AND runner=?2 AND ${ACTIVE[kind]}`).bind(id(jid), runnerName(await readJSON(req))).run();
    if (!r.meta.changes) throw new HttpError(409, "lease lost");
    return { ok: true };
  }],

  ["POST", /^\/api\/runner\/(recordings?|summar(?:y|ies)|asks?|vocab)\/(\d+)\/fail$/, async (req, env, [k, jid], _url, ctx) => {
    const kind = kindOf(k);
    const body = await readJSON<{ runner?: unknown; error?: unknown }>(req);
    const r = await env.DB.prepare(`UPDATE ${kind} SET status='error', error=?3, lease_until=NULL WHERE id=?1 AND runner=?2 AND ${ACTIVE[kind]}`)
      .bind(id(jid), runnerName(body), String(body.error ?? "failed")).run();
    if (!r.meta.changes) throw new HttpError(409, "lease lost");
    if (kind !== "vocab_scans") // a background scan is not worth a notification
      ctx.waitUntil(notifyJob(env, kind, id(jid), `${{ recordings: "處理", summaries: "摘要", asks: "提問" }[kind]}失敗：${String(body.error ?? "failed").slice(0, 80)}`));
    return { ok: true };
  }],

  ["POST", /^\/api\/runner\/summar(?:y|ies)\/(\d+)\/result$/, async (req, env, [sid], _url, ctx) => {
    const body = await readJSON<{ runner?: unknown; content_md?: unknown }>(req);
    if (typeof body.content_md !== "string") throw new HttpError(400, "content_md required");
    const r = await env.DB.prepare(`UPDATE summaries SET status='done', content_md=?3, error=NULL, lease_until=NULL
      WHERE id=?1 AND runner=?2 AND ${ACTIVE.summaries}`).bind(id(sid), runnerName(body), body.content_md).run();
    if (!r.meta.changes) throw new HttpError(409, "lease lost");
    ctx.waitUntil(notifyJob(env, "summaries", id(sid), "摘要完成"));
    return { ok: true };
  }],

  // Ask step 2 input, in the order asked; the runner name rides in ?runner= (GET has no body).
  ["GET", /^\/api\/runner\/asks?\/(\d+)\/transcripts$/, async (_req, env, [aid], url) => {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).map(Number);
    if (!ids.length || ids.length > 20 || !ids.every(Number.isInteger)) throw new HttpError(400, "ids: 1-20 comma-separated recording ids");
    await hold(env, "asks", id(aid), runnerName({ runner: url.searchParams.get("runner") }));
    // only the asker's recordings
    const { results } = await env.DB.prepare(`SELECT id, title, date(created_at, ${TZ}) AS date FROM recordings
      WHERE id IN (SELECT value FROM json_each(?1)) AND user_id=(SELECT user_id FROM asks WHERE id=?2) AND deleted_at IS NULL AND status='done'`)
      .bind(JSON.stringify(ids), id(aid))
      .all<{ id: number; title: string; date: string }>();
    const byId = new Map(results.map((r) => [r.id, r]));
    const rows = ids.flatMap((i) => byId.get(i) ?? []);
    return Promise.all(rows.map(async (r) => ({ ...r, transcript: await transcriptText(env, r.id) })));
  }],

  ["POST", /^\/api\/runner\/asks?\/(\d+)\/result$/, async (req, env, [aid], _url, ctx) => {
    const body = await readJSON<{ runner?: unknown; answer_md?: unknown; sources?: unknown }>(req);
    if (typeof body.answer_md !== "string") throw new HttpError(400, "answer_md required");
    const sources = body.sources ?? [];
    if (!Array.isArray(sources) || !sources.every(Number.isInteger)) throw new HttpError(400, "sources: [recording ids] required");
    const r = await env.DB.prepare(`UPDATE asks SET status='done', answer_md=?3, sources=?4, error=NULL, lease_until=NULL
      WHERE id=?1 AND runner=?2 AND ${ACTIVE.asks}`).bind(id(aid), runnerName(body), body.answer_md, JSON.stringify(sources)).run();
    if (!r.meta.changes) throw new HttpError(409, "lease lost");
    ctx.waitUntil(notifyJob(env, "asks", id(aid), "回答好了"));
    return { ok: true };
  }],

  // {runner, terms:[{term, misheard, kind}]}: upsert + recount (vocab.ts), scan done — one transaction
  ["POST", /^\/api\/runner\/vocab\/(\d+)\/result$/, async (req, env, [vid]) => {
    const body = await readJSON<{ runner?: unknown; terms?: unknown }>(req);
    const terms = parseTerms(body.terms);
    await hold(env, "vocab_scans", id(vid), runnerName(body));
    const { user_id } = await first<{ user_id: number }>(env.DB.prepare(`SELECT user_id FROM vocab_scans WHERE id=?`).bind(id(vid)));
    const r = await env.DB.batch([...saveTerms(env, user_id, terms), env.DB.prepare(`UPDATE vocab_scans SET status='done', error=NULL, lease_until=NULL
      WHERE id=?1 AND runner=?2 AND ${ACTIVE.vocab_scans}`).bind(id(vid), runnerName(body))]);
    if (!r.at(-1)!.meta.changes) throw new HttpError(409, "lease lost");
    return { ok: true };
  }],
];

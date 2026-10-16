import { askRoutes } from "./ask";
import { verifyAccessJwt } from "./auth";
import {
  type Env, type Handler, HttpError, errorResponse, first, languages, parseParts, partNumber, readJSON, serveR2, splitFilename, templates,
} from "./http";
import { notify, pushEnabled } from "./push";
import { listRunners, runnerRoutes } from "./runner";
import { STT_LANGS, getSettings, parseSettings, putSettings } from "./settings";
import { transferRoutes } from "./transfer";
import { transferEnabled } from "./transfer-merge";
import { enrol, isDefaultName, rematch, upsertPerson } from "./voice";
import { vocabRoutes } from "./vocab";

const PART_SIZE = 50 * 1024 * 1024;
const PROCESSING = `('converting','transcribing','cleaning')`;

const truthy = (v: string | null) => v !== null && v !== "" && v !== "0";
const id = (s: string) => Number(s);
// Scoping rule: every statement in a user handler binds uid; another user's row is "not found" (404), never 403.
const getRecording = (env: Env, rid: number, uid: number) => first(env.DB.prepare(`SELECT * FROM recordings WHERE id=? AND user_id=?`).bind(rid, uid));
const getPerson = (env: Env, pid: number, uid: number) =>
  first<{ id: number; name: string }>(env.DB.prepare(`SELECT id, name FROM people WHERE id=? AND user_id=?`).bind(pid, uid), "person not found");

function recLanguage(v: unknown) {
  if (v == null) return null;
  if (!STT_LANGS.includes(v as string)) throw new HttpError(400, `language must be one of ${STT_LANGS.join("|")}`);
  return v as string;
}

async function listPersons(env: Env, uid: number) {
  const { results } = await env.DB.prepare(`SELECT p.id, p.name,
      (SELECT count(*) FROM voiceprints v WHERE v.person_id=p.id) AS prints,
      (SELECT count(*) FROM speakers s WHERE s.person_id=p.id) AS speakers, p.last_used_at
    FROM people p WHERE p.user_id=? ORDER BY p.last_used_at DESC, p.id DESC`).bind(uid).all();
  return results;
}

async function detail(env: Env, rid: number, uid: number) {
  const recording = await getRecording(env, rid, uid);
  const [speakers, segments, summaries] = await env.DB.batch([
    env.DB.prepare(`SELECT s.id, s.label, s.display_name, s.person_id, s.auto, s.embedding IS NOT NULL AS has_embedding, s.emb_model,
        CASE WHEN p.id IS NOT NULL THEN json_object('person_id', p.id, 'name', p.name, 'score', s.suggest_score) END AS suggest
      FROM speakers s LEFT JOIN people p ON p.id=s.suggest_person_id WHERE s.recording_id=? AND s.user_id=? ORDER BY s.id`).bind(rid, uid),
    env.DB.prepare(`SELECT id, start_ms, end_ms, speaker_id, text_raw, text_clean FROM segments WHERE recording_id=? AND user_id=? ORDER BY start_ms, id`).bind(rid, uid),
    env.DB.prepare(`SELECT * FROM summaries WHERE recording_id=? AND user_id=? ORDER BY id DESC`).bind(rid, uid),
  ]);
  return {
    recording, segments: segments.results, summaries: summaries.results,
    speakers: (speakers.results as { suggest: string | null }[]).map((s) => ({ ...s, suggest: s.suggest ? JSON.parse(s.suggest) : null })),
  };
}

async function folderExists(env: Env, fid: unknown, uid: number) {
  if (fid === null || fid === undefined) return null;
  if (!Number.isInteger(fid)) throw new HttpError(400, "folder_id must be an integer or null");
  if (!(await env.DB.prepare(`SELECT 1 FROM folders WHERE id=? AND user_id=?`).bind(fid, uid).first())) throw new HttpError(400, "folder not found");
  return fid as number;
}

const folderRow = (env: Env, fid: number, uid: number) =>
  first(env.DB.prepare(`SELECT f.id, f.parent_id, f.name,
    (SELECT count(*) FROM recordings r WHERE r.folder_id=f.id AND r.deleted_at IS NULL AND r.status != 'importing') AS count FROM folders f WHERE f.id=? AND f.user_id=?`).bind(fid, uid), "folder not found");

// D1 raises UNIQUE violations as plain errors.
async function uniqueName<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "a folder with that name already exists here");
    throw e;
  }
}

export const routes: Route[] = [
  ["GET", /^\/media\/(\d+)$/, async (req, env, [rid], _u, _c, uid) => {
    const rec = await env.DB.prepare(`SELECT play_key FROM recordings WHERE id=? AND user_id=?`).bind(id(rid), uid).first<{ play_key: string | null }>();
    if (!rec?.play_key) return errorResponse(404, "media not ready");
    return serveR2(req, env.AUDIO, rec.play_key, "audio/mp4");
  }],

  ["GET", /^\/api\/recordings$/, async (_req, env, _p, url, _c, uid) => {
    const q = url.searchParams;
    const where = [`r.user_id=?`, `r.status != 'importing'`, `r.deleted_at IS ${truthy(q.get("trash")) ? "NOT NULL" : "NULL"}`];
    const args: unknown[] = [uid];
    const s = q.get("q");
    if (s) {
      where.push(`(r.title LIKE ? OR EXISTS(SELECT 1 FROM segments g WHERE g.recording_id=r.id AND (g.text_raw LIKE ? OR g.text_clean LIKE ?)))`);
      args.push(`%${s}%`, `%${s}%`, `%${s}%`);
    }
    const folder = q.get("folder");
    if (folder === "none") where.push(`r.folder_id IS NULL`);
    else if (folder) where.push(`r.folder_id=?`), args.push(Number(folder));
    if (q.has("filename")) where.push(`r.filename=?`), args.push(q.get("filename"));
    if (q.has("size")) where.push(`r.size=?`), args.push(Number(q.get("size")));
    const limit = q.get("view") === "recent" ? " LIMIT 50" : "";
    // top_speakers = the two who talk longest, with their share of talk time (scans each recording's segments;
    // ponytail: fine for hundreds of recordings, store per-recording totals if the list gets slow)
    const { results } = await env.DB.prepare(`SELECT r.*, EXISTS(SELECT 1 FROM summaries s WHERE s.recording_id=r.id AND s.status='done') AS has_summary,
        (SELECT json_group_array(json_object('name', name, 'pct', pct)) FROM (
          SELECT sp.display_name AS name, CAST(round(100.0 * sum(g.end_ms - g.start_ms) /
            max(1, (SELECT sum(end_ms - start_ms) FROM segments WHERE recording_id=r.id))) AS INTEGER) AS pct
          FROM segments g JOIN speakers sp ON sp.id=g.speaker_id WHERE g.recording_id=r.id
          GROUP BY g.speaker_id ORDER BY sum(g.end_ms - g.start_ms) DESC LIMIT 2)) AS top_speakers
      FROM recordings r WHERE ${where.join(" AND ")} ORDER BY r.created_at DESC, r.id DESC${limit}`).bind(...args).all<Record<string, unknown>>();
    return results.map((r) => ({ ...r, has_summary: r.has_summary === 1, top_speakers: JSON.parse(String(r.top_speakers ?? "[]")) }));
  }],

  ["GET", /^\/api\/recordings\/(\d+)$/, (_req, env, [rid], _u, _c, uid) => detail(env, id(rid), uid)],

  ["PATCH", /^\/api\/recordings\/(\d+)$/, async (req, env, [rid], _u, _c, uid) => {
    const body = await readJSON<{ title?: unknown; folder_id?: unknown }>(req);
    await getRecording(env, id(rid), uid);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title) await env.DB.prepare(`UPDATE recordings SET title=? WHERE id=? AND user_id=?`).bind(title, id(rid), uid).run();
    if ("folder_id" in body) {
      const fid = await folderExists(env, body.folder_id, uid);
      await env.DB.prepare(`UPDATE recordings SET folder_id=? WHERE id=? AND user_id=?`).bind(fid, id(rid), uid).run();
    }
    return getRecording(env, id(rid), uid);
  }],

  ["DELETE", /^\/api\/recordings\/(\d+)$/, async (_req, env, [rid], url, _c, uid) => {
    await getRecording(env, id(rid), uid);
    if (!truthy(url.searchParams.get("purge"))) {
      await env.DB.prepare(`UPDATE recordings SET deleted_at=datetime('now') WHERE id=? AND user_id=?`).bind(id(rid), uid).run();
      return { ok: true };
    }
    // a runner holding a live lease would write into a deleted row; an expired lease is fair game
    const gone = await env.DB.prepare(`DELETE FROM recordings WHERE id=? AND user_id=?
      AND NOT (status IN ${PROCESSING} AND lease_until >= datetime('now'))
      RETURNING status, source_key, play_key, upload_id`).bind(id(rid), uid).first<{ status: string; source_key: string | null; play_key: string | null; upload_id: string | null }>();
    if (!gone) throw new HttpError(409, "recording is being processed");
    if (gone.status === "uploading" && gone.source_key && gone.upload_id)
      await env.AUDIO.resumeMultipartUpload(gone.source_key, gone.upload_id).abort().catch(() => {});
    const keys = [gone.source_key, gone.play_key].filter((k): k is string => !!k);
    if (keys.length) await env.AUDIO.delete(keys);
    return { ok: true };
  }],

  ["POST", /^\/api\/recordings\/(\d+)\/restore$/, async (_req, env, [rid], _u, _c, uid) => {
    await getRecording(env, id(rid), uid);
    await env.DB.prepare(`UPDATE recordings SET deleted_at=NULL WHERE id=? AND user_id=?`).bind(id(rid), uid).run();
    return getRecording(env, id(rid), uid);
  }],

  ["POST", /^\/api\/recordings\/(\d+)\/retranscribe$/, async (req, env, [rid], _u, _c, uid) => {
    // body is optional: {language?}; language null = back to the settings default
    const json = req.headers.get("Content-Type")?.toLowerCase().startsWith("application/json") && (await req.clone().text()).trim();
    const body = json ? await readJSON<{ language?: unknown }>(req) : {};
    const lang = "language" in body ? [recLanguage(body.language)] : [];
    await getRecording(env, id(rid), uid);
    const r = await env.DB.prepare(`UPDATE recordings SET status='queued', error=NULL${lang.length ? ", language=?3" : ""}
      WHERE id=?1 AND user_id=?2 AND status IN ('done','error')`).bind(id(rid), uid, ...lang).run();
    if (!r.meta.changes) throw new HttpError(409, "recording is being processed");
    return getRecording(env, id(rid), uid);
  }],

  ["PATCH", /^\/api\/segments\/(\d+)$/, async (req, env, [sid], _u, _c, uid) => {
    const body = await readJSON<{ text?: unknown }>(req);
    if (body.text !== undefined && typeof body.text !== "string") throw new HttpError(400, "text must be a string");
    const r = await env.DB.prepare(`UPDATE segments SET text_clean=? WHERE id=? AND user_id=?`).bind(body.text ?? "", id(sid), uid).run();
    if (!r.meta.changes) throw new HttpError(404, "segment not found");
    return first(env.DB.prepare(`SELECT * FROM segments WHERE id=? AND user_id=?`).bind(id(sid), uid));
  }],

  ["POST", /^\/api\/segments\/(\d+)\/speaker$/, async (req, env, [sid], _u, _c, uid) => {
    const body = await readJSON<{ name?: unknown; scope?: unknown }>(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new HttpError(400, "name required");
    const seg = await first<{ recording_id: number; speaker_id: number | null }>(
      env.DB.prepare(`SELECT recording_id, speaker_id FROM segments WHERE id=? AND user_id=?`).bind(id(sid), uid), "segment not found");
    const person = !isDefaultName(name);
    const db = env.DB;
    // scope all: rename (= confirm) the speaker; a real name enrols it as a voiceprint, a default name drops its print
    const stmts = (body.scope || "all") === "all" && seg.speaker_id !== null
      ? person
        ? enrol(db, uid, seg.speaker_id, name)
        : [db.prepare(`UPDATE speakers SET display_name=?2, person_id=NULL, auto=2 WHERE id=?1 AND user_id=?3`).bind(seg.speaker_id, name, uid),
           db.prepare(`DELETE FROM voiceprints WHERE speaker_id=? AND user_id=?`).bind(seg.speaker_id, uid)]
      : [ // reuse a speaker with that name in this recording, else create one; then repoint the segment
          db.prepare(`INSERT INTO speakers(recording_id, label, display_name, user_id) SELECT ?1, 'custom', ?2, ?3
            WHERE NOT EXISTS(SELECT 1 FROM speakers WHERE recording_id=?1 AND display_name=?2 AND user_id=?3)`).bind(seg.recording_id, name, uid),
          db.prepare(`UPDATE segments SET speaker_id=(SELECT id FROM speakers WHERE recording_id=?1 AND display_name=?2 AND user_id=?4 ORDER BY id LIMIT 1)
            WHERE id=?3 AND user_id=?4`).bind(seg.recording_id, name, id(sid), uid),
          ...(person ? [upsertPerson(db, uid, name),
            db.prepare(`UPDATE speakers SET person_id=(SELECT id FROM people WHERE user_id=?3 AND name=?2), auto=0
              WHERE recording_id=?1 AND display_name=?2 AND user_id=?3`).bind(seg.recording_id, name, uid)] : []),
        ];
    await env.DB.batch(stmts);
    // a new voiceprint can re-score every recording; otherwise only this one changed
    await rematch(env, uid, person && (body.scope || "all") === "all" ? undefined : seg.recording_id);
    return detail(env, seg.recording_id, uid);
  }],

  ["GET", /^\/api\/people$/, async (_req, env, _p, _u, _c, uid) => {
    const { results } = await env.DB.prepare(`SELECT name FROM people WHERE user_id=? ORDER BY last_used_at DESC, id DESC LIMIT 20`).bind(uid).all<{ name: string }>();
    return results.map((r) => r.name);
  }],

  // ---- persons (speaker management); every change re-matches all recordings
  ["GET", /^\/api\/persons$/, (_req, env, _p, _u, _c, uid) => listPersons(env, uid)],

  ["PATCH", /^\/api\/persons\/(\d+)$/, async (req, env, [ps], _u, _c, uid) => {
    const pid = id(ps);
    const body = await readJSON<{ name?: unknown; merge?: unknown }>(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || [...name].length > 100) throw new HttpError(400, "name must be 1-100 characters");
    if (isDefaultName(name)) throw new HttpError(400, "name cannot be a default speaker name");
    const person = await getPerson(env, pid, uid);
    if (name === person.name) return listPersons(env, uid);
    const other = await env.DB.prepare(`SELECT id FROM people WHERE user_id=? AND name=?`).bind(uid, name).first<{ id: number }>();
    const db = env.DB;
    if (!other) {
      await db.batch([
        db.prepare(`UPDATE people SET name=?2 WHERE id=?1 AND user_id=?3`).bind(pid, name, uid),
        db.prepare(`UPDATE speakers SET display_name=?2 WHERE person_id=?1 AND user_id=?3`).bind(pid, name, uid),
      ]);
    } else if (body.merge !== true) {
      return Response.json({ detail: `${name} already exists`, existing_id: other.id }, { status: 409 });
    } else {
      await db.batch([
        db.prepare(`UPDATE voiceprints SET person_id=?2 WHERE person_id=?1 AND user_id=?3`).bind(pid, other.id, uid),
        db.prepare(`UPDATE speakers SET person_id=?2, display_name=?3 WHERE person_id=?1 AND user_id=?4`).bind(pid, other.id, name, uid),
        db.prepare(`UPDATE speakers SET suggest_person_id=?2 WHERE suggest_person_id=?1 AND user_id=?3`).bind(pid, other.id, uid),
        db.prepare(`UPDATE settings SET value=?2 WHERE user_id=?3 AND key='me' AND value=?1`).bind(JSON.stringify(pid), JSON.stringify(other.id), uid),
        db.prepare(`DELETE FROM people WHERE id=? AND user_id=?`).bind(pid, uid),
      ]);
    }
    await rematch(env, uid);
    return listPersons(env, uid);
  }],

  ["DELETE", /^\/api\/persons\/(\d+)$/, async (_req, env, [ps], _u, _c, uid) => {
    const pid = id(ps);
    await getPerson(env, pid, uid);
    const db = env.DB;
    // auto labels revert to "Speaker k" (k = position among the recording's diarized speakers, as in rematch); confirmed names stay
    await db.batch([
      db.prepare(`UPDATE speakers SET display_name='Speaker ' || (SELECT count(*) FROM speakers s
          WHERE s.recording_id=speakers.recording_id AND s.label<>'custom' AND s.id<=speakers.id), person_id=NULL, auto=0
        WHERE person_id=?1 AND auto=1 AND user_id=?2`).bind(pid, uid),
      db.prepare(`UPDATE speakers SET person_id=NULL WHERE person_id=?1 AND user_id=?2`).bind(pid, uid),
      db.prepare(`UPDATE speakers SET suggest_person_id=NULL, suggest_score=NULL WHERE suggest_person_id=?1 AND user_id=?2`).bind(pid, uid),
      db.prepare(`DELETE FROM settings WHERE user_id=? AND key='me' AND value=?`).bind(uid, JSON.stringify(pid)),
      db.prepare(`DELETE FROM voiceprints WHERE person_id=? AND user_id=?`).bind(pid, uid),
      db.prepare(`DELETE FROM people WHERE id=? AND user_id=?`).bind(pid, uid),
    ]);
    await rematch(env, uid);
    return { ok: true };
  }],

  // ---- settings
  ["GET", /^\/api\/settings$/, (_req, env, _p, _u, _c, uid) => getSettings(env, uid)],

  ["PUT", /^\/api\/settings$/, async (req, env, _p, _u, _c, uid) => {
    const patch = parseSettings(await readJSON(req));
    if (typeof patch === "string") throw new HttpError(400, patch);
    if (patch.me != null && !(await env.DB.prepare(`SELECT 1 FROM people WHERE id=? AND user_id=?`).bind(patch.me, uid).first()))
      throw new HttpError(400, "me: person not found");
    return putSettings(env, uid, patch);
  }],

  ["GET", /^\/api\/templates$/, async () => ({ templates, languages })],

  ["POST", /^\/api\/recordings\/(\d+)\/summaries$/, async (req, env, [rid], _u, _c, uid) => {
    const body = await readJSON<{ template_id?: unknown; language?: unknown }>(req);
    const lang = body.language || "zh-TW";
    if (!templates.some((t) => t.id === body.template_id) || !languages.some((l) => l.id === lang))
      throw new HttpError(400, "unknown template or language");
    await getRecording(env, id(rid), uid);
    return first(env.DB.prepare(`INSERT INTO summaries(recording_id, template_id, language, user_id) VALUES(?, ?, ?, ?) RETURNING *`).bind(id(rid), body.template_id, lang, uid));
  }],

  ["DELETE", /^\/api\/summaries\/(\d+)$/, async (_req, env, [sid], _u, _c, uid) => {
    const r = await env.DB.prepare(`DELETE FROM summaries WHERE id=? AND user_id=?`).bind(id(sid), uid).run();
    if (!r.meta.changes) throw new HttpError(404, "summary not found");
    return { ok: true };
  }],

  // ---- folders
  ["GET", /^\/api\/folders$/, async (_req, env, _p, _u, _c, uid) => {
    const { results } = await env.DB.prepare(`SELECT f.id, f.parent_id, f.name,
      (SELECT count(*) FROM recordings r WHERE r.folder_id=f.id AND r.deleted_at IS NULL) AS count FROM folders f WHERE f.user_id=? ORDER BY f.name, f.id`).bind(uid).all();
    return results;
  }],

  ["POST", /^\/api\/folders$/, async (req, env, _p, _u, _c, uid) => {
    const body = await readJSON<{ name?: unknown; parent_id?: unknown }>(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new HttpError(400, "name required");
    const parent = await folderExists(env, body.parent_id, uid);
    const row = await uniqueName(first<{ id: number }>(env.DB.prepare(`INSERT INTO folders(parent_id, name, user_id) VALUES(?, ?, ?) RETURNING id`).bind(parent, name, uid)));
    return folderRow(env, row.id, uid);
  }],

  ["PATCH", /^\/api\/folders\/(\d+)$/, async (req, env, [fs], _u, _c, uid) => {
    const fid = id(fs);
    const body = await readJSON<{ name?: unknown; parent_id?: unknown }>(req);
    await folderRow(env, fid, uid);
    const sets: string[] = [];
    const args: unknown[] = [];
    if (typeof body.name === "string" && body.name.trim()) sets.push("name=?"), args.push(body.name.trim());
    if ("parent_id" in body) {
      const parent = await folderExists(env, body.parent_id, uid);
      if (parent !== null) {
        const cycle = await env.DB.prepare(`WITH RECURSIVE anc(id) AS (
            SELECT ?1 UNION SELECT f.parent_id FROM folders f JOIN anc ON f.id=anc.id WHERE f.parent_id IS NOT NULL AND f.user_id=?3)
          SELECT 1 FROM anc WHERE id=?2`).bind(parent, fid, uid).first();
        if (cycle) throw new HttpError(400, "cannot move a folder into itself or a subfolder");
      }
      sets.push("parent_id=?"), args.push(parent);
    }
    if (sets.length) await uniqueName(env.DB.prepare(`UPDATE folders SET ${sets.join(", ")} WHERE id=? AND user_id=?`).bind(...args, fid, uid).run());
    return folderRow(env, fid, uid);
  }],

  ["DELETE", /^\/api\/folders\/(\d+)$/, async (_req, env, [fid], _u, _c, uid) => {
    // FK actions do the work: subfolders cascade, their recordings' folder_id → NULL (未分類)
    const r = await env.DB.prepare(`DELETE FROM folders WHERE id=? AND user_id=?`).bind(id(fid), uid).run();
    if (!r.meta.changes) throw new HttpError(404, "folder not found");
    return { ok: true };
  }],

  // ---- uploads (R2 multipart through the Worker)
  ["POST", /^\/api\/uploads$/, async (req, env, _p, _u, _c, uid) => {
    const body = await readJSON<{ filename?: unknown; size?: unknown; folder_id?: unknown; language?: unknown }>(req);
    if (typeof body.filename !== "string" || !body.filename) throw new HttpError(400, "filename required");
    if (!Number.isInteger(body.size) || (body.size as number) < 0) throw new HttpError(400, "size required");
    const lang = recLanguage(body.language);
    const folder = await folderExists(env, body.folder_id, uid);
    const { name, ext, stem } = splitFilename(body.filename);
    const { id: rid } = await first<{ id: number }>(env.DB.prepare(`INSERT INTO recordings(title, filename, status, size, folder_id, language, user_id)
      VALUES(?, ?, 'uploading', ?, ?, ?, ?) RETURNING id`).bind(stem, name, body.size, folder, lang, uid));
    const key = `u/${uid}/rec/${rid}/source${ext}`;
    try {
      const up = await env.AUDIO.createMultipartUpload(key);
      await env.DB.prepare(`UPDATE recordings SET source_key=?, upload_id=? WHERE id=? AND user_id=?`).bind(key, up.uploadId, rid, uid).run();
    } catch (e) {
      await env.DB.prepare(`DELETE FROM recordings WHERE id=? AND user_id=?`).bind(rid, uid).run();
      throw e;
    }
    return { recording_id: rid, part_size: PART_SIZE };
  }],

  ["PUT", /^\/api\/uploads\/(\d+)\/(\d+)$/, async (req, env, [rid, part], _u, _c, uid) => {
    const rec = await uploading(env, id(rid), uid);
    if (!req.body) throw new HttpError(400, "empty part");
    const p = await env.AUDIO.resumeMultipartUpload(rec.source_key, rec.upload_id).uploadPart(partNumber(part), req.body);
    return { etag: p.etag };
  }],

  ["POST", /^\/api\/uploads\/(\d+)\/complete$/, async (req, env, [rid], _u, _c, uid) => {
    const parts = parseParts(await readJSON(req));
    const rec = await uploading(env, id(rid), uid);
    if (rec.status !== "uploading") throw new HttpError(409, "an imported recording completes through /api/import"); // never queued: no runner, no charge
    const obj = await env.AUDIO.resumeMultipartUpload(rec.source_key, rec.upload_id).complete(parts);
    await env.DB.prepare(`UPDATE recordings SET status='queued', upload_id=NULL, size=? WHERE id=? AND user_id=?`).bind(obj.size, id(rid), uid).run();
    return getRecording(env, id(rid), uid);
  }],

  ["DELETE", /^\/api\/uploads\/(\d+)$/, async (_req, env, [rid], _u, _c, uid) => {
    const rec = await uploading(env, id(rid), uid);
    await env.AUDIO.resumeMultipartUpload(rec.source_key, rec.upload_id).abort().catch(() => {});
    await env.DB.prepare(`DELETE FROM recordings WHERE id=? AND user_id=?`).bind(id(rid), uid).run();
    return { ok: true };
  }],

  ["GET", /^\/api\/runners$/, (_req, env, _p, _u, _c, uid) => listRunners(env, uid)],

  // Forget an offline runner (online = seen within 3 min, as in listRunners); it re-registers if it ever claims again.
  ["DELETE", /^\/api\/runners\/([^/]+)$/, async (_req, env, [name]) => {
    const r = await env.DB.prepare(`DELETE FROM runners WHERE name=? AND last_seen < datetime('now','-3 minutes')`).bind(decodeURIComponent(name)).run();
    if (!r.meta.changes) throw new HttpError(409, "runner is online or unknown");
    return { ok: true };
  }],

  // ---- Web Push (push.ts); key null = VAPID keys unset, the UI hides the toggle
  ["GET", /^\/api\/push\/key$/, async (_req, env) => ({ key: pushEnabled(env) ? env.VAPID_PUBLIC_KEY : null })],

  // a shared browser's endpoint follows whoever subscribed last
  ["POST", /^\/api\/push\/subscribe$/, async (req, env, _p, _u, _c, uid) => { // body = PushSubscription.toJSON()
    const b = await readJSON<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>(req);
    const { p256dh, auth } = b.keys ?? {};
    if (typeof b.endpoint !== "string" || !b.endpoint.startsWith("https://") || typeof p256dh !== "string" || typeof auth !== "string")
      throw new HttpError(400, "{endpoint: https URL, keys: {p256dh, auth}} required");
    await env.DB.prepare(`INSERT INTO push_subscriptions(endpoint, p256dh, auth, user_id) VALUES(?1, ?2, ?3, ?4)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=?2, auth=?3, user_id=?4`).bind(b.endpoint, p256dh, auth, uid).run();
    return { ok: true };
  }],

  ["DELETE", /^\/api\/push\/subscribe$/, async (req, env, _p, _u, _c, uid) => {
    const b = await readJSON<{ endpoint?: unknown }>(req);
    if (typeof b.endpoint !== "string") throw new HttpError(400, "endpoint required");
    await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?`).bind(b.endpoint, uid).run();
    return { ok: true };
  }],

  ["POST", /^\/api\/push\/test$/, async (_req, env, _p, _u, _c, uid) => {
    await notify(env, uid, { title: "Yanroku", body: "通知已開啟", url: "/", tag: "test" });
    return { ok: true };
  }],

  ...transferRoutes,
  ...askRoutes,
  ...vocabRoutes,
  ...runnerRoutes,
];

async function uploading(env: Env, rid: number, uid: number) {
  const rec = await first<{ status: string; source_key: string; upload_id: string }>(
    env.DB.prepare(`SELECT status, source_key, upload_id FROM recordings WHERE id=? AND user_id=?`).bind(rid, uid));
  // 'importing' = an imported recording's play.m4a (transfer.ts): parts and abort go through the same routes
  if (!["uploading", "importing"].includes(rec.status) || !rec.upload_id) throw new HttpError(409, "upload already completed");
  return rec;
}

// ---- the seam: an entry passes `identify` (who is calling) and may add routes and /api/config fields.
// Core's own entry (index.ts) uses accessIdentify; see docs/SPEC.md "Extending the server".
export type Caller = { uid: number } | { runner: true };
export type Identify<E extends Env = Env> = (req: Request, env: E, path: string, ctx: ExecutionContext) => Promise<Caller | Response>;
export type Route<E extends Env = Env> = [method: string, path: RegExp, handler: Handler<E>];

export interface WorkerOptions<E extends Env = Env> {
  identify: Identify<E>;
  extraRoutes?: Route<E>[]; // matched before core routes: may add a route or override one (same method + path)
  config?: (env: E) => Record<string, unknown>; // shallow-merged over core's GET /api/config body
  onScheduled?: ExportedHandler<E>["scheduled"];
}

// Self-host: Cloudflare Access in front of everything, every caller is user 1 (runner routes act on each job row's user_id).
export const accessIdentify: Identify = async (req, env, path) => {
  if (env.DEV_NO_AUTH !== "1") {
    if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return errorResponse(503, "Access not configured");
    if (!(await verifyAccessJwt(req.headers.get("Cf-Access-Jwt-Assertion"), env.ACCESS_TEAM, env.ACCESS_AUD))) return errorResponse(403, "forbidden");
  }
  return path.startsWith("/api/runner/") ? { runner: true } : { uid: 1 };
};

export function createWorker<E extends Env = Env>(opts: WorkerOptions<E>): ExportedHandler<E> {
  const all: Route<E>[] = [...(opts.extraRoutes ?? []), ...routes];
  return {
    async fetch(req, env, ctx): Promise<Response> {
      const url = new URL(req.url);
      const method = req.method === "HEAD" ? "GET" : req.method;
      // public: tells the clients how to sign in and which UI extensions to load
      if (url.pathname === "/api/config" && method === "GET")
        return Response.json({ auth_mode: "access", app_name: "Yanroku", extensions: [], transfer: transferEnabled(env), ...opts.config?.(env) });
      const who = await opts.identify(req, env, url.pathname, ctx);
      if (who instanceof Response) return who;
      // CSRF: a session cookie may ride along on cross-site requests; the runner sends no Sec-Fetch-* headers
      if (method !== "GET" && ["cross-site", "same-site"].includes(req.headers.get("Sec-Fetch-Site") ?? "")) return errorResponse(403, "cross-site request");
      let pathMatched = false;
      for (const [m, re, handler] of all) {
        const match = re.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (m !== method) continue;
        try {
          const v = await handler(req, env, match.slice(1), url, ctx, "uid" in who ? who.uid : 0);
          return v instanceof Response ? v : Response.json(v);
        } catch (e) {
          if (e instanceof HttpError) return errorResponse(e.status, e.message);
          console.error(req.method, url.pathname, e);
          return errorResponse(500, String((e as Error)?.message ?? e));
        }
      }
      return pathMatched ? errorResponse(405, "method not allowed") : errorResponse(404, "not found");
    },
    ...(opts.onScheduled && { scheduled: opts.onScheduled }),
  };
}

export { listRunners } from "./runner";

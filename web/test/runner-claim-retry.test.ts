// node test/runner-claim-retry.test.ts — claim retries transient D1 errors and returns 503 after exhaustion.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve: (s, c, next) => {
    try {
      return next(s, c);
    } catch (e) {
      // Try adding .ts for relative imports
      if (s.startsWith(".")) {
        try {
          return next(`${s}.ts`, c);
        } catch {}
      }
      throw e;
    }
  }
});

const { LocalD1 } = await import("../local/d1.ts");
const { createWorker, accessIdentify } = await import("../src/app.ts");

const db = new LocalD1(":memory:");
await db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')))`);
await db.exec(`INSERT INTO users(id) VALUES(1)`);
await db.exec(`CREATE TABLE runners(name TEXT PRIMARY KEY, last_seen TEXT DEFAULT (datetime('now')), stt TEXT, version TEXT, version_time TEXT)`);
await db.exec(`CREATE TABLE asks(id INTEGER PRIMARY KEY, user_id INTEGER, question TEXT, status TEXT, runner TEXT, lease_until TEXT, error TEXT, answer_md TEXT, sources TEXT, created_at TEXT DEFAULT (datetime('now')))`);
await db.exec(`CREATE TABLE recordings(id INTEGER PRIMARY KEY, user_id INTEGER, filename TEXT, size INTEGER, source_key TEXT, play_key TEXT, language TEXT, status TEXT, title TEXT, duration_s REAL, runner TEXT, lease_until TEXT, error TEXT, not_before TEXT, note TEXT, upload_id TEXT, deleted_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
await db.exec(`CREATE TABLE summaries(id INTEGER PRIMARY KEY, user_id INTEGER, recording_id INTEGER, template_id TEXT, language TEXT, status TEXT, runner TEXT, lease_until TEXT, error TEXT, content_md TEXT, created_at TEXT DEFAULT (datetime('now')))`);
await db.exec(`CREATE TABLE vocab_scans(id INTEGER PRIMARY KEY, user_id INTEGER, from_id INTEGER, to_id INTEGER, status TEXT, runner TEXT, lease_until TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')))`);
await db.exec(`CREATE TABLE segments(id INTEGER PRIMARY KEY, recording_id INTEGER, start_ms INTEGER, end_ms INTEGER, speaker_id INTEGER, text_raw TEXT, text_clean TEXT, user_id INTEGER)`);
await db.exec(`CREATE TABLE speakers(id INTEGER PRIMARY KEY, recording_id INTEGER, label TEXT, display_name TEXT, embedding TEXT, emb_model TEXT, auto INTEGER DEFAULT 1, user_id INTEGER)`);
await db.exec(`CREATE TABLE settings(user_id INTEGER PRIMARY KEY, stt_lang TEXT, cleanup INTEGER, vocab TEXT, about TEXT, content_focus TEXT, instructions TEXT, me INTEGER)`);
await db.exec(`CREATE TABLE people(id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT)`);
await db.exec(`CREATE TABLE vocab_suggestions(user_id INTEGER, term TEXT, misheard TEXT, kind TEXT, status TEXT DEFAULT 'new', hits INTEGER DEFAULT 0, fixes INTEGER DEFAULT 0, recordings INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(user_id, term))`);
await db.exec(`INSERT INTO settings(user_id, stt_lang, cleanup, vocab) VALUES(1, 'zh-TW', 1, '[]')`);

let failCount = 0;
let callCount = 0;
const errors = ["D1_ERROR: Network connection lost.", "D1_ERROR: out of memory: SQLITE_NOMEM"];

const failingDB = {
  ...db,
  prepare: (sql: string) => {
    const stmt = db.prepare(sql);
    const makeWrapped = (bound: ReturnType<typeof stmt.bind>) => ({
      ...bound,
      async first<T>() {
        callCount++;
        if (failCount > 0) {
          failCount--;
          throw new Error(errors[0]);
        }
        return bound.first<T>();
      },
      async all<T>() {
        callCount++;
        if (failCount > 0) {
          failCount--;
          throw new Error(errors[0]);
        }
        return bound.all<T>();
      },
      async run() {
        callCount++;
        if (failCount > 0) {
          failCount--;
          throw new Error(errors[0]);
        }
        return bound.run();
      },
      bind(...args: unknown[]) {
        return makeWrapped(bound.bind(...args));
      },
    });
    return makeWrapped(stmt);
  },
} as unknown as D1Database;

const r2: R2Bucket = { head: async () => ({ size: 1000 }) } as unknown as R2Bucket;
const worker = createWorker({ identify: accessIdentify });
const req = (body: object) => new Request("https://yanroku.app/api/runner/claim", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// Case 1: fail first 2 attempts, succeed on 3rd (Network connection lost)
await db.exec(`INSERT INTO asks(id, user_id, question, status) VALUES(1, 1, 'test', 'queued')`);
callCount = 0;
failCount = 2;
const res1 = await worker.fetch(req({ runner: "test-runner", asks: true }), { DB: failingDB, AUDIO: r2, ACCESS_TEAM: "t", ACCESS_AUD: "a", DEV_NO_AUTH: "1" }, {} as ExecutionContext);
assert.equal(res1.status, 200);
assert.ok(callCount >= 3, `should retry: called ${callCount} times`);
const job1 = await res1.json<{ job: { kind: string; id: number } }>();
assert.equal(job1.job?.kind, "ask");
assert.equal(job1.job?.id, 1);

// Case 2: SQLITE_NOMEM is not retried inline (the same statement would fail again) → 503, longer Retry-After, not "transient"
await db.exec(`DELETE FROM asks`);
await db.exec(`INSERT INTO asks(id, user_id, question, status) VALUES(2, 1, 'test2', 'queued')`);
callCount = 0;
failCount = 1;
errors[0] = "D1_ERROR: out of memory: SQLITE_NOMEM";
const res2 = await worker.fetch(req({ runner: "test-runner2", asks: true }), { DB: failingDB, AUDIO: r2, ACCESS_TEAM: "t", ACCESS_AUD: "a", DEV_NO_AUTH: "1" }, {} as ExecutionContext);
assert.equal(res2.status, 503);
assert.equal(callCount, 1, "NOMEM must not be retried");
assert.equal(res2.headers.get("Retry-After"), "30");
assert.equal(res2.headers.get("x-yanroku-d1-class"), "nomem");
assert.equal(res2.headers.get("x-yanroku-transient"), null, "NOMEM stays an error, not a transient warning");
failCount = 0;

// Case 3: fail all 3 attempts → 503 with transient headers
await db.exec(`DELETE FROM asks`);
await db.exec(`INSERT INTO asks(id, user_id, question, status) VALUES(3, 1, 'test3', 'queued')`);
callCount = 0;
failCount = 10;
errors[0] = "D1_ERROR: Network connection lost.";
const res3 = await worker.fetch(req({ runner: "test-runner3", asks: true }), { DB: failingDB, AUDIO: r2, ACCESS_TEAM: "t", ACCESS_AUD: "a", DEV_NO_AUTH: "1" }, {} as ExecutionContext);
assert.equal(res3.status, 503);
assert.equal(res3.headers.get("Retry-After"), "2");
assert.equal(res3.headers.get("x-yanroku-transient"), "d1");
assert.equal(res3.headers.get("x-yanroku-d1-class"), "network");
assert.equal(callCount, 3, "1 try + 2 retries, then give up");
const detail3 = await res3.json<{ detail: string }>();
assert.ok(detail3.detail.includes("stage="), "detail should include stage");

// Case 4: non-transient error → no retry, 500
await db.exec(`DELETE FROM asks`);
await db.exec(`INSERT INTO asks(id, user_id, question, status) VALUES(4, 1, 'test4', 'queued')`);
callCount = 0;
failCount = 1;
errors[0] = "UNIQUE constraint failed: asks.id";
const res4 = await worker.fetch(req({ runner: "test-runner4", asks: true }), { DB: failingDB, AUDIO: r2, ACCESS_TEAM: "t", ACCESS_AUD: "a", DEV_NO_AUTH: "1" }, {} as ExecutionContext);
assert.equal(res4.status, 500);
assert.equal(callCount, 1, "non-transient error should not retry");

// Case 5: idempotency - same runner retries claim and gets same job
await db.exec(`DELETE FROM asks`);
await db.exec(`INSERT INTO asks(id, user_id, question, status) VALUES(5, 1, 'test5', 'queued')`);
// First claim succeeds
const res5a = await worker.fetch(req({ runner: "test-runner5", asks: true }), { DB: db, AUDIO: r2, ACCESS_TEAM: "t", ACCESS_AUD: "a", DEV_NO_AUTH: "1" }, {} as ExecutionContext);
assert.equal(res5a.status, 200);
const job5a = await res5a.json<{ job: { kind: string; id: number } }>();
assert.equal(job5a.job?.id, 5);
// Same runner retries (simulating lost response) - should get same job
const res5b = await worker.fetch(req({ runner: "test-runner5", asks: true }), { DB: db, AUDIO: r2, ACCESS_TEAM: "t", ACCESS_AUD: "a", DEV_NO_AUTH: "1" }, {} as ExecutionContext);
assert.equal(res5b.status, 200);
const job5b = await res5b.json<{ job: { kind: string; id: number } }>();
assert.equal(job5b.job?.id, 5, "same runner should get same job on retry");

// Case 6: the ask index lists each recording's speakers that have segments (speakers-driven query, chunked)
await db.exec(`DELETE FROM asks`);
for (let r = 100; r < 100 + 450; r++) { // > 2 chunks of ASK_SPEAKER_CHUNK
  await db.exec(`INSERT INTO recordings(id, user_id, filename, status, title) VALUES(${r}, 1, 'r${r}.m4a', 'done', 'R${r}')`);
  await db.exec(`INSERT INTO speakers(id, recording_id, label, display_name, user_id) VALUES(${r * 10}, ${r}, 'SPEAKER_00', 'Amy', 1), (${r * 10 + 1}, ${r}, 'SPEAKER_01', 'Ben', 1), (${r * 10 + 2}, ${r}, 'SPEAKER_02', 'Silent', 1)`);
  await db.exec(`INSERT INTO segments(recording_id, start_ms, end_ms, speaker_id, text_raw, user_id) VALUES(${r}, 0, 1, ${r * 10}, 'a', 1), (${r}, 1, 2, ${r * 10 + 1}, 'b', 1), (${r}, 2, 3, ${r * 10}, 'c', 1)`);
}
await db.exec(`INSERT INTO asks(id, user_id, question, status) VALUES(6, 1, 'who?', 'queued')`);
const res6 = await worker.fetch(req({ runner: "test-runner6", asks: true }), { DB: db, AUDIO: r2, ACCESS_TEAM: "t", ACCESS_AUD: "a", DEV_NO_AUTH: "1" }, {} as ExecutionContext);
assert.equal(res6.status, 200);
const job6 = await res6.json<{ job: { index: { id: number; speakers: string[] }[] } }>();
assert.equal(job6.job.index.length, 450);
for (const r of job6.job.index) assert.deepEqual([...r.speakers].sort(), ["Amy", "Ben"], `recording ${r.id} speakers`);

console.log("runner-claim-retry ok");

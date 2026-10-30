// node test/d1-retry.test.ts — D1 error classes, retryIdempotent, the 503 a failed D1 call becomes, and the vocab scan's paged reads.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve: (s, c, next) => {
    try {
      return next(s, c);
    } catch (e) {
      if (s.startsWith(".")) return next(`${s}.ts`, c);
      throw e;
    }
  },
});

const { D1_ATTEMPTS, HttpError, d1Class, d1ErrorResponse, isTransientD1, retryIdempotent } = await import("../src/http.ts");
const { LocalD1 } = await import("../local/d1.ts");
const { scanJob, scanMaterial } = await import("../src/vocab.ts");

// classification: the messages behind YANROKU-CLOUD-2/3/4/5, plus ones that must not be touched
const cases: [string, ReturnType<typeof d1Class>][] = [
  ["D1_ERROR: Network connection lost.", "network"],
  ["Error: D1_ERROR: Network connection lost. stage=rec", "network"],
  ["D1_ERROR: internal error; reference = 0a1b2c3d4e5f", "internal"],
  ["D1_ERROR: Internal error while starting up D1 DB storage caused object to be reset.", "reset"],
  ["D1_ERROR: Durable Object reset because its code was updated.", "reset"],
  ["D1_ERROR: D1 DB's isolate exceeded its memory limit: Replica disconnected from primary", "network"],
  ["D1_ERROR: The operation timed out", "timeout"],
  ["D1_ERROR: out of memory: SQLITE_NOMEM", "nomem"],
  ["D1_ERROR: internal error: SQLITE_NOMEM", "nomem"], // memory wins over "internal": not retried
  ["D1_ERROR: UNIQUE constraint failed: asks.id", null],
  ["D1_ERROR: no such table: x", null],
  ["internal error", null], // not from D1
  ["TypeError: cannot read properties of undefined", null],
];
for (const [msg, want] of cases) assert.equal(d1Class(new Error(msg)), want, msg);
assert.equal(d1Class(new HttpError(503, "Network connection lost")), null, "HttpError is never a D1 failure");
assert.equal(isTransientD1(new Error("D1_ERROR: Network connection lost.")), true);
assert.equal(isTransientD1(new Error("D1_ERROR: internal error; reference = x")), true);
assert.equal(isTransientD1(new Error("D1_ERROR: out of memory: SQLITE_NOMEM")), false, "nomem is not retried");
assert.equal(isTransientD1(new Error("D1_ERROR: UNIQUE constraint failed")), false);

// retryIdempotent: a transient failure then success
const flaky = (errs: string[], value = "ok") => {
  let calls = 0;
  const fn = async () => {
    const e = errs[calls++];
    if (e) throw new Error(e);
    return value;
  };
  return { fn, calls: () => calls };
};
let f = flaky(["D1_ERROR: Network connection lost."]);
assert.equal(await retryIdempotent(f.fn), "ok");
assert.equal(f.calls(), 2);
f = flaky(["D1_ERROR: internal error; reference = a", "D1_ERROR: Network connection lost."]);
assert.equal(await retryIdempotent(f.fn), "ok");
assert.equal(f.calls(), 3);

// gives up after D1_ATTEMPTS and rethrows the last error
f = flaky(Array(10).fill("D1_ERROR: Network connection lost."));
await assert.rejects(retryIdempotent(f.fn), /Network connection lost/);
assert.equal(f.calls(), D1_ATTEMPTS);
assert.ok(D1_ATTEMPTS >= 2 && D1_ATTEMPTS <= 3, "1–2 retries");

// non-transient and nomem: thrown at once
for (const msg of ["D1_ERROR: UNIQUE constraint failed: asks.id", "D1_ERROR: out of memory: SQLITE_NOMEM"]) {
  f = flaky([msg]);
  await assert.rejects(retryIdempotent(f.fn), (e: Error) => e.message === msg);
  assert.equal(f.calls(), 1, `${msg} is not retried`);
}
let httpCalls = 0;
await assert.rejects(retryIdempotent(async () => { httpCalls++; throw new HttpError(409, "lease lost"); }), HttpError);
assert.equal(httpCalls, 1);

// jitter stays small: 2 retries with the default base wait < 150 ms in all
const t0 = Date.now();
f = flaky(["D1_ERROR: Network connection lost.", "D1_ERROR: Network connection lost."]);
await retryIdempotent(f.fn);
assert.ok(Date.now() - t0 < 400, `retries took ${Date.now() - t0} ms`);

// d1ErrorResponse: 503 + Retry-After when exhausted; nothing for other errors
const r = d1ErrorResponse(new Error("D1_ERROR: Network connection lost."), "D1_ERROR: Network connection lost. stage=rec")!;
assert.equal(r.status, 503);
assert.equal(r.headers.get("Retry-After"), "2");
assert.equal(r.headers.get("x-yanroku-transient"), "d1");
assert.equal(r.headers.get("x-yanroku-d1-class"), "network");
assert.deepEqual(await r.json(), { detail: "D1_ERROR: Network connection lost. stage=rec" });
const nomem = d1ErrorResponse(new Error("D1_ERROR: out of memory: SQLITE_NOMEM"), "nomem")!;
assert.equal(nomem.status, 503);
assert.equal(nomem.headers.get("Retry-After"), "30");
assert.equal(nomem.headers.get("x-yanroku-transient"), null);
assert.equal(d1ErrorResponse(new Error("D1_ERROR: no such table: x"), "x"), null);
assert.equal(d1ErrorResponse(new HttpError(404, "not found"), "x"), null);

// vocab scan: segments are read page by page (no one big batch) and give the same material as reading them all at once
const db = new LocalD1(":memory:");
await db.exec(`CREATE TABLE recordings(id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, status TEXT, deleted_at TEXT)`);
await db.exec(`CREATE TABLE segments(id INTEGER PRIMARY KEY, recording_id INTEGER, start_ms INTEGER, text_raw TEXT, text_clean TEXT)`);
await db.exec(`CREATE TABLE vocab_suggestions(user_id INTEGER, term TEXT, status TEXT)`);
await db.exec(`CREATE TABLE settings(user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id, key))`);
await db.exec(`INSERT INTO settings(user_id, key, value) VALUES(1, 'vocab', '["Yanroku"]')`);
await db.exec(`INSERT INTO vocab_suggestions VALUES(1, 'old', 'dismissed')`);
await db.exec(`INSERT INTO recordings VALUES(1, 1, 'long', 'done', NULL), (2, 1, 'short', 'done', NULL), (3, 2, 'other user', 'done', NULL)`);
const rows: string[] = [];
for (let i = 0; i < 1800; i++) {
  // every 3rd segment changed by cleanup; same start_ms for pairs, so paging must break ties on id
  const pad = "今天的會議討論了很多事情".repeat(2); // ~30 chars a line, so the text cap is hit mid-recording
  const raw = `段落 ${i} 言録 ${pad}`, clean = i % 3 === 0 ? `段落 ${i} 言錄 ${pad}` : i % 3 === 1 ? `段落 ${i}，言録 ${pad}` : null;
  rows.push(`(1, ${Math.floor(i / 2) * 1000}, '${raw}', ${clean === null ? "NULL" : `'${clean}'`})`);
}
await db.exec(`INSERT INTO segments(recording_id, start_ms, text_raw, text_clean) VALUES ${rows.join(",")}`);
await db.exec(`INSERT INTO segments(recording_id, start_ms, text_raw, text_clean) VALUES(2, 0, 'hi', 'Hi'), (3, 0, 'secret', NULL)`);
const all = (rid: number) => db.prepare(`SELECT text_raw, text_clean FROM segments WHERE recording_id=? ORDER BY start_ms, id`).bind(rid)
  .all<{ text_raw: string; text_clean: string | null }>().then((r) => r.results);

let statements = 0;
const counting = { ...db, prepare: (sql: string) => (statements++, db.prepare(sql)),
  batch: () => { throw new Error("scanJob must not batch every segment at once"); } } as unknown as D1Database;
const job = await scanJob({ DB: counting } as never, { id: 9, from_id: 1, to_id: 3, user_id: 1 });
assert.equal(job.kind, "vocab");
assert.deepEqual(job.vocab, ["Yanroku"]);
assert.deepEqual(job.skip, ["old"]);
assert.deepEqual(job.recordings.map((x) => x.id), [1, 2], "only the scan user's recordings");
assert.deepEqual(job.recordings[0], { id: 1, title: "long", ...scanMaterial(await all(1)) });
assert.deepEqual(job.recordings[1], { id: 2, title: "short", ...scanMaterial(await all(2)) });
assert.equal(job.recordings[0].diffs.length, 150);
assert.equal(job.recordings[0].text.length, 20_000);
assert.ok(statements < 12, `paged reads stop once the material is complete (${statements} statements)`);

console.log("d1-retry ok");

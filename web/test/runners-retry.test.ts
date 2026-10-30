// node test/runners-retry.test.ts — listRunners retries transient D1 errors and returns 503 after exhaustion.
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
await db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT, created_at TEXT DEFAULT (datetime('now')))`);
await db.exec(`INSERT INTO users(id, email) VALUES(1, 'test@example.com')`);
await db.exec(`CREATE TABLE runners(name TEXT PRIMARY KEY, last_seen TEXT DEFAULT (datetime('now')), stt TEXT, version TEXT, version_time TEXT)`);
await db.exec(`CREATE TABLE recordings(id INTEGER PRIMARY KEY, user_id INTEGER, filename TEXT, status TEXT, title TEXT, runner TEXT, lease_until TEXT, deleted_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
await db.exec(`CREATE TABLE summaries(id INTEGER PRIMARY KEY, user_id INTEGER, recording_id INTEGER, status TEXT, runner TEXT, lease_until TEXT, created_at TEXT DEFAULT (datetime('now')))`);
await db.exec(`CREATE TABLE asks(id INTEGER PRIMARY KEY, user_id INTEGER, question TEXT, status TEXT, runner TEXT, lease_until TEXT, created_at TEXT DEFAULT (datetime('now')))`);
await db.exec(`CREATE TABLE vocab_scans(id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT, runner TEXT, lease_until TEXT, created_at TEXT DEFAULT (datetime('now')))`);
await db.exec(`INSERT INTO runners(name, last_seen) VALUES('runner1', datetime('now', '-1 minute'))`);
await db.exec(`INSERT INTO recordings(id, user_id, filename, status) VALUES(1, 1, 'test.m4a', 'queued')`);

let failCount = 0;
let callCount = 0;

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
          throw new Error("D1_ERROR: Network connection lost.");
        }
        return bound.first<T>();
      },
      async all<T>() {
        callCount++;
        if (failCount > 0) {
          failCount--;
          throw new Error("D1_ERROR: Network connection lost.");
        }
        return bound.all<T>();
      },
      async run() {
        callCount++;
        if (failCount > 0) {
          failCount--;
          throw new Error("D1_ERROR: Network connection lost.");
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

const r2: R2Bucket = {} as R2Bucket;
const worker = createWorker({ identify: accessIdentify });
const req = () => new Request("https://yanroku.app/api/runners", {
  method: "GET",
  headers: { "Content-Type": "application/json" },
});

// Case 1: fail first 2 attempts on first SELECT, succeed on 3rd
callCount = 0;
failCount = 2;
const res1 = await worker.fetch(req(), { DB: failingDB, AUDIO: r2, ACCESS_TEAM: "t", ACCESS_AUD: "a", DEV_NO_AUTH: "1" }, {} as ExecutionContext);
assert.equal(res1.status, 200);
assert.ok(callCount >= 3, `should retry first SELECT: called ${callCount} times`);
const data1 = await res1.json<{ runners: unknown[]; queued: object }>();
assert.ok(Array.isArray(data1.runners));

// Case 2: fail all 3 attempts → 503 with transient headers
callCount = 0;
failCount = 10;
const res2 = await worker.fetch(req(), { DB: failingDB, AUDIO: r2, ACCESS_TEAM: "t", ACCESS_AUD: "a", DEV_NO_AUTH: "1" }, {} as ExecutionContext);
assert.equal(res2.status, 503);
assert.equal(res2.headers.get("Retry-After"), "2");
assert.equal(res2.headers.get("x-yanroku-transient"), "d1");
assert.ok(["network", "timeout", "internal", "reset", "nomem"].includes(res2.headers.get("x-yanroku-d1-class") ?? ""));

// Case 3: non-transient error → no retry, 500
callCount = 0;
failCount = 1;
const nonTransientDB = {
  ...db,
  prepare: (sql: string) => {
    const stmt = db.prepare(sql);
    const makeWrapped = (bound: ReturnType<typeof stmt.bind>) => ({
      ...bound,
      async all<T>() {
        callCount++;
        if (failCount > 0) {
          failCount--;
          throw new Error("UNIQUE constraint failed");
        }
        return bound.all<T>();
      },
      async first<T>() {
        callCount++;
        if (failCount > 0) {
          failCount--;
          throw new Error("UNIQUE constraint failed");
        }
        return bound.first<T>();
      },
      bind(...args: unknown[]) {
        return makeWrapped(bound.bind(...args));
      },
    });
    return makeWrapped(stmt);
  },
} as unknown as D1Database;
const res3 = await worker.fetch(req(), { DB: nonTransientDB, AUDIO: r2, ACCESS_TEAM: "t", ACCESS_AUD: "a", DEV_NO_AUTH: "1" }, {} as ExecutionContext);
assert.equal(res3.status, 500);
assert.equal(callCount, 1, "non-transient error should not retry");

console.log("runners-retry ok");

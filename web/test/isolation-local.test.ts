// node test/isolation-local.test.ts — the two-user isolation suite (test/isolation.ts) against the local-mode server
// (web/local: node:sqlite + files instead of D1 + R2), with test/fake-identify.ts's identities.
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

registerHooks({ resolve: (s, c, next) => { try { return next(s, c); } catch (e) { if (s.startsWith(".")) return next(`${s}.ts`, c); throw e; } } });
const { routes } = await import("../src/app.ts");
const { fakeIdentify } = await import("./fake-identify.ts");
const { startLocalServer } = await import("../local/server.ts");
const { runIsolation } = await import("./isolation.ts");

const dir = mkdtempSync(join(tmpdir(), "yanroku-local-isolation-"));
const server = await startLocalServer({
  dataDir: dir, publicDir: "public", migrationsDir: "migrations", host: "127.0.0.1", port: 0,
  runnerToken: "x".repeat(32), vars: { TRANSFER_ENABLED: "1" }, identify: fakeIdentify, log: () => {},
});
try {
  await runIsolation({
    base: `http://127.0.0.1:${server.port}`,
    tokenA: { "X-Test-Uid": "1" }, tokenB: { "X-Test-Uid": "2" }, runner: { "X-Test-Runner": "1" },
    routes, query: (sql) => server.db.prepare(sql).all() as Record<string, unknown>[],
  });
} finally {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}

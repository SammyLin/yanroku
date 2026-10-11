// Run via `npm run test:isolation` (test/isolation.sh starts the Worker with test/fake-identify.ts).
import { registerHooks } from "node:module";
import { runIsolation } from "./isolation.ts";

// src/ imports are extensionless (bundler style); node needs the .ts
registerHooks({ resolve: (s, c, next) => { try { return next(s, c); } catch (e) { if (s.startsWith(".")) return next(`${s}.ts`, c); throw e; } } });
const { routes } = await import("../src/app.ts");

await runIsolation({
  base: process.env.BASE ?? "http://127.0.0.1:8811",
  tokenA: { "X-Test-Uid": "1" }, tokenB: { "X-Test-Uid": "2" }, runner: { "X-Test-Runner": "1" },
  routes, d1: ["noteapp"], dbDir: process.env.ISOLATION_DB_DIR!,
});

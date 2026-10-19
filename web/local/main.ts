// Entry for `yanroku up` (runner/up.go starts it): node web/local/main.ts --host 127.0.0.1 --port 8780 --data <dir>
// Secrets come from the environment, never argv: YANROKU_RUNNER_TOKEN (required), LOCAL_PASSWORD.
// Prints "yanroku: listening <port>" once it serves requests; SIGTERM / SIGINT shut it down cleanly. Under `yanroku up`
// (YANROKU_PARENT_PIPE=1) Ctrl-C is left to the parent, which stops the runner first so it can hand its job back over
// this server, then sends SIGTERM; and the server exits when its stdin closes, i.e. when the parent is gone.
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

// src/ imports are extensionless (bundler style); node needs the .ts
registerHooks({ resolve: (s, c, next) => { try { return next(s, c); } catch (e) { if (s.startsWith(".")) return next(`${s}.ts`, c); throw e; } } });

const web = resolve(dirname(new URL(import.meta.url).pathname), "..");
const { values: a } = parseArgs({ options: { host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "8780" }, data: { type: "string" } } });
const fail = (msg: string) => {
  console.error(`yanroku web: ${msg}`);
  process.exit(1);
};
const port = Number(a.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid port ${a.port}`);
if (!a.data) fail("--data is required");
const runnerToken = process.env.YANROKU_RUNNER_TOKEN ?? "";
if (!runnerToken) fail("YANROKU_RUNNER_TOKEN is not set (start the server with `yanroku up`)");

const { startLocalServer } = await import("./server.ts");
const vars = Object.fromEntries(
  ["VOICE_MATCH_THRESHOLD", "VOICE_SUGGEST_THRESHOLD", "TRANSFER_ENABLED", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]
    .flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
);
let server: Awaited<ReturnType<typeof startLocalServer>>;
try {
  server = await startLocalServer({
    dataDir: resolve(a.data!), publicDir: join(web, "public"), migrationsDir: join(web, "migrations"),
    host: a.host!, port, password: process.env.LOCAL_PASSWORD, runnerToken, vars,
  });
} catch (e) {
  fail((e as Error).message);
}
console.log(`yanroku: listening ${server!.port}`);

let closing = false;
const shutdown = async () => {
  if (closing) process.exit(1);
  closing = true;
  await server!.close();
  process.exit(0);
};
const child = process.env.YANROKU_PARENT_PIPE === "1";
process.on("SIGTERM", shutdown);
process.on("SIGINT", child ? () => {} : shutdown);
// "end" and "close" both fire when the parent goes away: react once, without the second-signal force exit
if (child) process.stdin.once("close", () => closing || shutdown()).resume();

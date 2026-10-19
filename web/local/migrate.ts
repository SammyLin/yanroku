// Applies web/migrations/*.sql not yet in d1_migrations (same table and naming as `wrangler d1 migrations apply`),
// each in its own transaction, in file-name order.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalD1 } from "./d1.ts";

export function migrate(d1: LocalD1, dir: string): string[] {
  d1.db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  const done = new Set((d1.db.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    try {
      d1.transaction(() => {
        d1.db.exec(sql);
        d1.db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(name);
      });
    } catch (e) {
      throw new Error(`migration ${name} failed: ${(e as Error).message}`);
    }
    applied.push(name);
  }
  return applied;
}

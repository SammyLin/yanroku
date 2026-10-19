// D1 on node:sqlite, for `yanroku up` (local mode). Covers what src/ uses: prepare/bind/first/all/run/raw, batch (one
// transaction, like D1), exec, meta.changes / meta.last_row_id. Foreign keys are on, as they always are in D1.
import { DatabaseSync } from "node:sqlite";

type Value = null | number | bigint | string | Uint8Array;

function toSqlite(v: unknown, i: number): Value {
  if (v === null || typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0; // D1 stores booleans as 1 / 0
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new TypeError(`D1_TYPE_ERROR: Type '${v === undefined ? "undefined" : typeof v}' not supported for value at index ${i}`);
}

export class LocalD1 {
  readonly db: DatabaseSync;
  #counters;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    this.#counters = this.db.prepare("SELECT total_changes() AS n, changes() AS c, last_insert_rowid() AS id");
  }

  prepare(sql: string) {
    return new LocalStatement(this, sql, []);
  }

  async batch(stmts: LocalStatement[]) {
    return this.transaction(() => stmts.map((s) => s.execute()));
  }

  async exec(sql: string) {
    const start = performance.now();
    this.db.exec(sql);
    return { count: sql.split(";").filter((s) => s.trim()).length, duration: performance.now() - start };
  }

  close() {
    this.db.close();
  }

  /** Runs fn inside BEGIN / COMMIT; any throw rolls back and is rethrown. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  counters() {
    return this.#counters.get() as { n: number; c: number; id: number };
  }
}

export class LocalStatement {
  readonly #d1: LocalD1;
  readonly #sql: string;
  readonly #values: Value[];

  constructor(d1: LocalD1, sql: string, values: Value[]) {
    this.#d1 = d1;
    this.#sql = sql;
    this.#values = values;
  }

  bind(...values: unknown[]) {
    return new LocalStatement(this.#d1, this.#sql, values.map(toSqlite));
  }

  /** Rows plus D1-shaped meta. Synchronous, so a batch runs inside one transaction. */
  execute() {
    const start = performance.now();
    const before = this.#d1.counters().n;
    const results = this.#d1.db.prepare(this.#sql).all(...this.#values).map((r) => ({ ...r }));
    const after = this.#d1.counters();
    // changes() counts this statement's rows only (not triggers or FK actions), like D1; it keeps the previous write's
    // value across a read, so a statement that changed nothing at all (total_changes() unmoved) reports 0
    const changes = after.n === before ? 0 : after.c;
    return {
      success: true as const,
      results: results as Record<string, unknown>[],
      meta: { changes, last_row_id: after.id, changed_db: changes > 0, duration: performance.now() - start, rows_read: results.length, rows_written: changes },
    };
  }

  async all<T = Record<string, unknown>>() {
    const r = this.execute();
    return { ...r, results: r.results as T[] };
  }

  async run<T = Record<string, unknown>>() {
    return this.all<T>();
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.execute().results[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column] as T;
  }

  async raw<T = unknown[]>(opts?: { columnNames?: boolean }): Promise<T[]> {
    const rows = this.execute().results;
    const out = rows.map((r) => Object.values(r)) as T[];
    if (opts?.columnNames) out.unshift((rows[0] ? Object.keys(rows[0]) : []) as T);
    return out;
  }
}

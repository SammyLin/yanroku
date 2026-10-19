// node test/local-d1.test.ts — web/local/d1.ts behaves like D1 where src/ depends on it.
import assert from "node:assert/strict";
import { LocalD1 } from "../local/d1.ts";

const db = new LocalD1(":memory:");
await db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT UNIQUE, flag INTEGER, parent INTEGER REFERENCES t(id))");

// run: meta.changes / last_row_id; RETURNING rows come back too
const ins = await db.prepare("INSERT INTO t(name, flag) VALUES(?, ?)").bind("a", true).run();
assert.equal(ins.meta.changes, 1);
assert.equal(ins.meta.last_row_id, 1);
assert.deepEqual((await db.prepare("INSERT INTO t(name) VALUES(?1) RETURNING id, name").bind("b").run()).results, [{ id: 2, name: "b" }]);
assert.equal((await db.prepare("UPDATE t SET flag=0").run()).meta.changes, 2);
assert.equal((await db.prepare("SELECT * FROM t").run()).meta.changes, 0); // a read changes nothing

// first / first(col) / all / raw; booleans bind as 1 / 0
assert.deepEqual(await db.prepare("SELECT id, name, flag FROM t WHERE name=?").bind("a").first(), { id: 1, name: "a", flag: 0 });
assert.equal(await db.prepare("SELECT name FROM t WHERE id=?").bind(2).first("name"), "b");
assert.equal(await db.prepare("SELECT name FROM t WHERE id=?").bind(99).first(), null);
await assert.rejects(db.prepare("SELECT name FROM t").first("nope"), /D1_COLUMN_NOTFOUND/);
assert.equal(await db.prepare("SELECT ?1 AS v").bind(false).first("v"), 0);
assert.deepEqual((await db.prepare("SELECT id FROM t ORDER BY id").all()).results, [{ id: 1 }, { id: 2 }]);
assert.deepEqual(await db.prepare("SELECT id, name FROM t ORDER BY id").raw(), [[1, "a"], [2, "b"]]);
assert.throws(() => db.prepare("SELECT ?").bind(undefined), /D1_TYPE_ERROR/);

// batch: one transaction; any failure rolls every statement back
const [x, y] = await db.batch([db.prepare("INSERT INTO t(name) VALUES('c')"), db.prepare("SELECT count(*) AS n FROM t")]);
assert.equal(x.meta.changes, 1);
assert.deepEqual(y.results, [{ n: 3 }]);
await assert.rejects(db.batch([db.prepare("INSERT INTO t(name) VALUES('d')"), db.prepare("INSERT INTO t(name) VALUES('a')")]), /UNIQUE/);
assert.equal(await db.prepare("SELECT count(*) AS n FROM t WHERE name='d'").first("n"), 0);

// foreign keys are on, as in D1
await assert.rejects(db.prepare("INSERT INTO t(name, parent) VALUES('e', 42)").run(), /FOREIGN KEY/);

// meta.changes counts the statement's own rows, not a trigger's (D1 = sqlite3_changes)
await db.exec("CREATE TABLE log(n INTEGER); CREATE TRIGGER t_log AFTER UPDATE ON t BEGIN INSERT INTO log VALUES(1); INSERT INTO log VALUES(2); END");
assert.equal((await db.prepare("UPDATE t SET flag=1 WHERE name='a'").run()).meta.changes, 1);
assert.equal((await db.prepare("UPDATE t SET flag=1 WHERE name='nobody'").run()).meta.changes, 0);

db.close();
console.log("local d1 ok");

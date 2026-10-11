// Guard tests. Run after `yarn build`: `yarn check`
import assert from "node:assert/strict";

import { guardSql, stripComments } from "../dist/pg/guard.js";

const allow = [
  "SELECT 1",
  "select * from member where \"createdAt\" > now() - interval '1 day';",
  "WITH x AS (SELECT 1) SELECT * FROM x",
  "EXPLAIN ANALYZE SELECT * FROM ledgers LIMIT 10",
  "SHOW search_path",
  "TABLE accounts",
  "VALUES (1,2)",
  "SELECT 'drop table x; delete from y' AS s",
  "SELECT $$insert into z$$ AS s",
  "SELECT updated_at, \"updatedAt\", deleted, settings FROM t -- drop table t",
  "SELECT /* delete */ 1",
];
const deny = [
  "DELETE FROM member",
  "INSERT INTO t VALUES (1)",
  "SELECT 1; DROP TABLE member",
  "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
  "SELECT pg_sleep(100)",
  "BEGIN",
  "SET ROLE postgres",
  "SELECT * FROM t FOR UPDATE",
  "DO $$ BEGIN END $$",
  "CREATE TABLE x (id int)",
  "",
  "-- just a comment",
];

for (const s of allow) {
  const g = guardSql(s);
  assert.equal(g.ok, true, `should allow: ${s} -> ${g.reason}`);
}
for (const s of deny) {
  const g = guardSql(s);
  assert.equal(g.ok, false, `should deny: ${s}`);
}

assert.equal(stripComments("select 1 -- x\n, '--not' /* c */ , 2").trim(), "select 1 \n, '--not'   , 2");
assert.equal(guardSql("select 1;").sql, "select 1");
assert.equal(guardSql("explain select 1").wrappable, false);
assert.equal(guardSql("select 1").wrappable, true);

console.log(`guard ok: ${allow.length} allowed, ${deny.length} denied`);

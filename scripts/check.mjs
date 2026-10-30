// Guard tests. Run after `yarn build`: `yarn check`
import assert from "node:assert/strict";

import { guardSql, stripComments } from "../dist/pg/guard.js";
import { normalizePath, writeTarget } from "../dist/bo/paths.js";

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

// ---------- bo_api paths ----------
const target = (m, p) => writeTarget(m, normalizePath(p).pathname);
assert.equal(target("POST", "/account/funding/tx/deposit"), "deposit");
assert.equal(target("POST", "/account/funding/tx/withdraw/"), "withdraw");
assert.equal(target("POST", "/account/funding/tx/deposit?x=1"), "deposit");
assert.equal(target("POST", "/account/funding/tx/adjust"), null);
assert.equal(target("POST", "/account/funding/tx/deposit/../adjust"), null);
assert.equal(target("POST", "/account/funding/tx/x/%2e%2e/adjust"), null);
assert.equal(target("POST", "/account/funding/tx/x/%2e%2e/deposit"), "deposit"); // resolves to the real path
assert.equal(target("POST", "/account%2Ffunding/tx/deposit"), null);
assert.equal(target("PUT", "/account/funding/tx/deposit"), null);
assert.equal(target("DELETE", "/account/funding/tx/withdraw"), null);
assert.throws(() => normalizePath("//evil.com/x"));
assert.throws(() => normalizePath("/\\evil.com/x"));
assert.equal(normalizePath("/account/funding/tx?memberId=a").search, "?memberId=a");
console.log("bo_api paths ok");

// ---------- versions ----------
import { execFileSync } from "node:child_process";
execFileSync(process.execPath, [new URL("./version-sync.mjs", import.meta.url).pathname, "--check"], { stdio: "inherit" });
console.log("versions ok: package.json = manifest.json = .claude-plugin/*");

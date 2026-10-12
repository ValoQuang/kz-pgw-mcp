// Stdio smoke test. Two modes:
//   node scripts/smoke.mjs            → no creds needed: server starts, lists 12 tools, write tools are gated, pg_query reports missing config
//   node scripts/smoke.mjs --live     → uses ~/.config/kz-pgw/.env: runs SELECT 1, list tables, write must be rejected
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const live = process.argv.includes("--live");
// Never write skills into the real ~/.claude during tests.
const env = { ...process.env, KZ_SKILLS_DIR: "off" };
if (!live) {
  // Strip everything so the no-config path is exercised.
  for (const k of Object.keys(env)) if (/^(KZ_|PG|SSH_)/.test(k) && k !== "KZ_SKILLS_DIR") delete env[k];
  env.KZ_PGW_CONFIG = "/nonexistent/.env";
}

const server = spawn("node", [new URL("../dist/cli.js", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
  env,
});

const rl = createInterface({ input: server.stdout });
const pending = new Map();
let nextId = 1;
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function send(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 45_000);
  });
}
const notify = (method, params) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const call = (name, args) => send("tools/call", { name, arguments: args });
const text = (res) => res.result?.content?.[0]?.text ?? JSON.stringify(res.error ?? res.result);

let failed = 0;
function expect(label, cond, detail) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : `\n     ${detail}`}`);
  if (!cond) failed++;
}

try {
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  notify("notifications/initialized", {});

  const tools = (await send("tools/list", {})).result.tools.map((t) => t.name).sort();
  const want = [
    "bo_api", "bo_create_deposit", "bo_create_withdraw", "bo_find_member", "bo_login", "bo_logout", "bo_submit_totp", "bo_whoami",
    "pg_describe_table", "pg_list_databases", "pg_list_tables", "pg_query",
  ];
  expect(`tools/list has ${want.length} tools`, JSON.stringify(tools) === JSON.stringify(want), tools.join(", "));

  const who = await call("bo_whoami", {});
  expect("bo_whoami works without creds", !who.result?.isError, text(who));

  if (!live) {
    const q = await call("pg_query", { sql: "select 1" });
    expect("pg_query → missing config message", q.result?.isError && /not configured|missing PGHOST/.test(text(q)), text(q));

    const login = await call("bo_login", { group: "tpg1" });
    expect("bo_login → missing config message", login.result?.isError && /not configured|KZ_USERNAME/.test(text(login)), text(login));

    const dep = await call("bo_create_deposit", {
      group: "tpg1", memberId: "00000000-0000-0000-0000-000000000000", fundingProfileId: "00000000-0000-0000-0000-000000000000", amount: 1, method: "x/y",
    });
    expect("bo_create_deposit gated by KZ_PGW_ALLOW_WRITES", dep.result?.isError && /KZ_PGW_ALLOW_WRITES/.test(text(dep)), text(dep));

    const api = await call("bo_api", { group: "tpg1", method: "POST", path: "/x" });
    expect("bo_api POST gated", api.result?.isError && /KZ_PGW_ALLOW_WRITES/.test(text(api)), text(api));
  } else {
    const one = await call("pg_query", { sql: "select 1 as ok, now() as at" });
    expect("pg_query select 1", !one.result?.isError, text(one));
    const dbs = await call("pg_list_databases", {});
    expect("pg_list_databases", !dbs.result?.isError, text(dbs));
    const tbl = await call("pg_list_tables", { pattern: "%member%" });
    expect("pg_list_tables %member%", !tbl.result?.isError, text(tbl));
    const del = await call("pg_query", { sql: "delete from member" });
    expect("write rejected", del.result?.isError === true, text(del));
    const fm = await call("bo_find_member", { group: "tpg1", limit: 2 });
    expect("bo_find_member via shared pool", !fm.result?.isError, text(fm));
  }
} catch (e) {
  console.error("FAIL:", e.message);
  failed++;
} finally {
  server.kill();
}
console.log(failed ? `\n${failed} failed` : "\nsmoke ok");
process.exit(failed ? 1 : 0);

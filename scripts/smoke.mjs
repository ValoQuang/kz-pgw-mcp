// Stdio smoke test. Two modes:
//   node scripts/smoke.mjs            → no creds needed: server starts, lists 17 tools, role gate + project/dev tool lists, write tools gated, missing-config messages
//   node scripts/smoke.mjs --live     → uses ~/.config/kz-pgw/.env: runs SELECT 1, list tables, write must be rejected
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

const live = process.argv.includes("--live");
// Never write skills into the real ~/.claude during tests.
const env = { ...process.env, KZ_SKILLS_DIR: "off" };
// Live mode runs as dev unless KZ_ROLE is already set.
if (live && !env.KZ_ROLE) env.KZ_ROLE = "dev";
if (!live) {
  // Strip everything so the no-config path is exercised.
  for (const k of Object.keys(env)) if (/^(KZ_|PG|SSH_)/.test(k) && k !== "KZ_SKILLS_DIR") delete env[k];
  // Fresh temp file: kz_set_role writes here, never to the real config.
  env.KZ_PGW_CONFIG = `${await mkdtemp(`${tmpdir()}/kz-pgw-smoke-`)}/.env`;
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
    "bo_api", "bo_check_access", "bo_create_deposit", "bo_create_withdraw", "bo_find_member", "bo_list_methods", "bo_list_orders",
    "bo_login", "bo_logout", "bo_submit_totp", "bo_whoami",
    "kz_guide", "kz_set_role",
    "pg_describe_table", "pg_list_databases", "pg_list_tables", "pg_query",
  ];
  expect(`tools/list has ${want.length} tools`, JSON.stringify(tools) === JSON.stringify(want), tools.join(", "));

  if (!live) {
    // No role yet: tools ask for it, kz_guide still works.
    const noRole = await call("bo_whoami", {});
    expect("no role → asks for role", noRole.result?.isError && /Role not set/.test(text(noRole)), text(noRole));
    const g0 = await call("kz_guide", {});
    expect("kz_guide works without role", !g0.result?.isError && /quick guide/.test(text(g0)), text(g0));

    // project: pg_* hidden, no DB needed.
    const setP = await call("kz_set_role", { role: "project" });
    expect("kz_set_role project (firstTime + guide)", !setP.result?.isError && setP.result?.structuredContent?.firstTime === true, text(setP));
    const pTools = (await send("tools/list", {})).result.tools.map((t) => t.name);
    expect("project hides pg_*", !pTools.some((n) => /^pg_/.test(n)) && pTools.includes("bo_list_orders"), pTools.join(", "));
    const acc = await call("bo_check_access", { group: "tpg1" });
    expect("project bo_check_access → missing BO config (no DB)", acc.result?.isError && /KZ_USERNAME/.test(text(acc)), text(acc));

    // dev: everything back.
    await call("kz_set_role", { role: "dev" });
    const dTools = (await send("tools/list", {})).result.tools.map((t) => t.name);
    expect("dev shows pg_*", dTools.includes("pg_query"), dTools.join(", "));
  }

  const who = await call("bo_whoami", {});
  expect("bo_whoami works without creds", !who.result?.isError, text(who));

  if (!live) {
    const lo = await call("bo_list_orders", { group: "tpg1", provider: "cpay-2", since: "2026-10-01" });
    expect("bo_list_orders → needs login", lo.result?.isError && /Not logged in|KZ_USERNAME|not configured/.test(text(lo)), text(lo));
    const lo0 = await call("bo_list_orders", { group: "tpg1" });
    expect("bo_list_orders → needs provider/orderRef/memberId", lo0.result?.isError && /at least one of provider, orderRef, memberId/.test(text(lo0)), text(lo0));
    const lo1 = await call("bo_list_orders", { group: "tpg1", provider: "cpay-2" });
    expect("bo_list_orders provider → needs since", lo1.result?.isError && /since is required/.test(text(lo1)), text(lo1));

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

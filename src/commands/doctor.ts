/** `kz-pgw-mcp doctor`: print resolved config (secrets masked) and test the DB connection. Exit 1 on any problem. */

import { BO_KEYS, PG_KEYS, loadedFrom, role, summary } from "../core/config.js";
import { CLI, SERVER_NAME } from "../core/constants.js";
import { missing } from "../core/env.js";
import { CONFIG_FILE } from "../core/paths.js";
import { VERSION } from "../core/version.js";
import { closePools, getPool } from "../pg/db.js";
import { formatPgError } from "../pg/errors.js";

async function checkDb(): Promise<boolean> {
  process.stdout.write("staging db: connecting... ");
  try {
    const r = await (await getPool()).query<{ db: string; user: string; v: string }>(
      "SELECT current_database() AS db, current_user AS user, version() AS v",
    );
    console.log(`ok (${r.rows[0].db} as ${r.rows[0].user}, ${r.rows[0].v.split(" on ")[0]})`);
    return true;
  } catch (e) {
    console.log(formatPgError(e));
    return false;
  }
}

export async function doctor(): Promise<void> {
  console.log(`${SERVER_NAME} ${VERSION}`);
  console.log(`config file: ${CONFIG_FILE} ${loadedFrom.includes(CONFIG_FILE) ? "(loaded)" : "(not found)"}`);
  if (loadedFrom.length) console.log(`loaded from: ${loadedFrom.join(", ")}`);
  console.log("");
  for (const [k, v] of Object.entries(summary())) console.log(`  ${k.padEnd(26)} ${v}`);
  console.log("");

  const boMissing = missing(BO_KEYS);
  const r = role.get();
  console.log(`role: ${r ?? "not set (run init, or pick it in Claude on first use)"}`);
  console.log(`backoffice: ${boMissing.length ? `MISSING ${boMissing.join(", ")}` : "ok"}`);
  if (r === "project") {
    console.log("staging db: not used (project role)");
    if (boMissing.length) console.log(`\nfix: ${CLI.init}`);
    process.exit(boMissing.length ? 1 : 0);
  }
  const pgMissing = missing(PG_KEYS);
  if (pgMissing.length) console.log(`staging db: MISSING ${pgMissing.join(", ")}`);
  const dbOk = !pgMissing.length && (await checkDb());
  await closePools();

  const healthy = !boMissing.length && dbOk;
  if (!healthy) console.log(`\nfix: ${CLI.init}`);
  process.exit(healthy ? 0 : 1);
}

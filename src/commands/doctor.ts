/** `kz-pgw-mcp doctor`: print resolved config (secrets masked) and test the DB connection. Exit 1 on any problem. */

import { BO_KEYS, PG_KEYS, loadedFrom, summary } from "../core/config.js";
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
  } finally {
    await closePools();
  }
}

export async function doctor(): Promise<void> {
  console.log(`${SERVER_NAME} ${VERSION}`);
  console.log(`config file: ${CONFIG_FILE} ${loadedFrom.includes(CONFIG_FILE) ? "(loaded)" : "(not found)"}`);
  if (loadedFrom.length) console.log(`loaded from: ${loadedFrom.join(", ")}`);
  console.log("");
  for (const [k, v] of Object.entries(summary())) console.log(`  ${k.padEnd(22)} ${v}`);
  console.log("");

  const boMissing = missing(BO_KEYS);
  const pgMissing = missing(PG_KEYS);
  console.log(`backoffice: ${boMissing.length ? `MISSING ${boMissing.join(", ")}` : "ok"}`);
  if (pgMissing.length) console.log(`staging db: MISSING ${pgMissing.join(", ")}`);
  const dbOk = !pgMissing.length && (await checkDb());

  const healthy = !boMissing.length && dbOk;
  if (!healthy) console.log(`\nfix: ${CLI.init}`);
  process.exit(healthy ? 0 : 1);
}

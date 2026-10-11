import { BO_KEYS, CONFIG_FILE, INIT_CMD, PG_KEYS, loadedFrom, missing, summary } from "./config.js";
import { closePools, getPool } from "./pg/db.js";
import { formatPgError } from "./pg/errors.js";
import { VERSION } from "./version.js";

export async function doctor(): Promise<void> {
  console.log(`kz-pgw-mcp ${VERSION}`);
  console.log(`config file: ${CONFIG_FILE} ${loadedFrom.includes(CONFIG_FILE) ? "(loaded)" : "(not found)"}`);
  if (loadedFrom.length) console.log(`loaded from: ${loadedFrom.join(", ")}`);
  console.log("");
  for (const [k, v] of Object.entries(summary())) console.log(`  ${k.padEnd(22)} ${v}`);
  console.log("");

  let exit = 0;
  const bo = missing(BO_KEYS);
  const pgm = missing(PG_KEYS);
  console.log(`backoffice: ${bo.length ? `MISSING ${bo.join(", ")}` : "ok"}`);
  if (bo.length) exit = 1;

  if (pgm.length) {
    console.log(`staging db: MISSING ${pgm.join(", ")}`);
    exit = 1;
  } else {
    process.stdout.write("staging db: connecting... ");
    try {
      const r = await (await getPool()).query<{ db: string; user: string; v: string }>(
        "SELECT current_database() AS db, current_user AS user, version() AS v",
      );
      console.log(`ok (${r.rows[0].db} as ${r.rows[0].user}, ${r.rows[0].v.split(" on ")[0]})`);
    } catch (e) {
      console.log(formatPgError(e));
      exit = 1;
    } finally {
      await closePools();
    }
  }
  if (exit) console.log(`\nfix: ${INIT_CMD}`);
  process.exit(exit);
}

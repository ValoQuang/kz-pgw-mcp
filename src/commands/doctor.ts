/** `kz-pgw-mcp doctor`: print resolved config (secrets masked) and test the DB connection. Exit 1 on any problem. */

import { BO_KEYS, PG_KEYS, loadedFrom, summary } from "../core/config.js";
import { CLI, SERVER_NAME } from "../core/constants.js";
import { missing } from "../core/env.js";
import { CONFIG_FILE } from "../core/paths.js";
import { VERSION } from "../core/version.js";
import { closePools, getPool } from "../pg/db.js";
import { formatPgError } from "../pg/errors.js";

interface RolePowers {
  superuser: boolean;
  createrole: boolean;
  createdb: boolean;
  write_all: boolean;
  can_write: boolean;
  reads_secrets: boolean;
}

/** Warn when PGUSER can do more than read. The server is read-only either way; a read-only role makes a leaked .env harmless. */
async function checkRole(): Promise<void> {
  const r = await (await getPool()).query<RolePowers>(`
    SELECT r.rolsuper AS superuser,
           r.rolcreaterole AS createrole,
           r.rolcreatedb AS createdb,
           pg_has_role(current_user, 'pg_write_all_data', 'MEMBER') AS write_all,
           EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public'
                   AND has_table_privilege(format('%I.%I', t.schemaname, t.tablename), 'INSERT,UPDATE,DELETE,TRUNCATE')) AS can_write,
           COALESCE(to_regclass('public.credential') IS NOT NULL
                    AND has_column_privilege('public.credential', 'secret', 'SELECT'), false) AS reads_secrets
    FROM pg_roles r WHERE r.rolname = current_user`);
  const p = r.rows[0];
  const powers = [
    p.superuser && "superuser",
    p.createrole && "CREATEROLE",
    p.createdb && "CREATEDB",
    p.write_all && "pg_write_all_data",
    p.can_write && "can write tables",
    p.reads_secrets && "can read credential.secret",
  ].filter((x): x is string => !!x);
  console.log(
    powers.length
      ? `db role: WARNING ${powers.join(", ")}. Ask DevOps for the kz_pgw_ro role (https://github.com/ValoQuang/kz-pgw-mcp/blob/main/docs/security/readonly-role.sql).`
      : "db role: read-only",
  );
}

async function checkDb(): Promise<boolean> {
  process.stdout.write("staging db: connecting... ");
  try {
    const r = await (await getPool()).query<{ db: string; user: string; v: string }>(
      "SELECT current_database() AS db, current_user AS user, version() AS v",
    );
    console.log(`ok (${r.rows[0].db} as ${r.rows[0].user}, ${r.rows[0].v.split(" on ")[0]})`);
    await checkRole();
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

/** Postgres pools (one per database), read-only query runners, catalog queries. */

import pg from "pg";

import { pg as cfg } from "../core/config.js";
import { ROWS, SERVER_NAME, TIMEOUT_MS } from "../core/constants.js";
import { guardSql, limitWrap } from "./guard.js";
import { Tunnel, tunnelFromEnv } from "./tunnel.js";

const { Pool, types } = pg;

// Return bigint/numeric/int8 as strings (pg default), dates as ISO strings.
types.setTypeParser(1114, (v: string) => v); // timestamp
types.setTypeParser(1184, (v: string) => v); // timestamptz
types.setTypeParser(1082, (v: string) => v); // date


function sslFromEnv(): pg.PoolConfig["ssl"] {
  const mode = cfg.sslMode();
  if (!mode || mode === "disable" || mode === "prefer") return undefined;
  if (mode === "verify-full" || mode === "verify-ca") return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

const pools = new Map<string, pg.Pool>();
let tunnel: Tunnel | null | undefined; // undefined = not yet resolved

export function getTunnel(): Tunnel | null {
  if (tunnel === undefined) {
    const t = tunnelFromEnv();
    tunnel = t ? new Tunnel(t, { host: cfg.host(), port: cfg.port() }) : null;
  }
  return tunnel;
}

async function endpoint(): Promise<{ host: string; port: number }> {
  const t = getTunnel();
  return t ? t.listen() : { host: cfg.host(), port: cfg.port() };
}

export async function getPool(database: string = cfg.database()): Promise<pg.Pool> {
  cfg.check();
  let p = pools.get(database);
  if (!p) {
    const { host, port } = await endpoint();
    p = new Pool({
      host,
      port,
      database,
      user: cfg.user(),
      password: cfg.password(),
      max: 2,
      idleTimeoutMillis: TIMEOUT_MS.pgIdle,
      connectionTimeoutMillis: TIMEOUT_MS.pgConnect,
      application_name: SERVER_NAME,
      ssl: sslFromEnv(),
    });
    pools.set(database, p);
  }
  return p;
}

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
  getTunnel()?.close();
}

export class SqlRejected extends Error {}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  duration_ms: number;
}

async function inReadOnlyTx<T>(database: string | undefined, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await (await getPool(database)).connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${cfg.timeoutMs()}`);
    return await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection may already be dead
    }
    client.release();
  }
}

/** Free-form SQL from the model. Guarded, LIMIT-wrapped, read-only. */
export async function runReadOnly(rawSql: string, maxRows: number, database?: string): Promise<QueryResult> {
  const g = guardSql(rawSql);
  if (!g.ok) throw new SqlRejected(g.reason);

  const max = Math.min(Math.max(1, maxRows), ROWS.hardMax);
  const sql = g.wrappable ? limitWrap(g.sql, max) : g.sql;

  const start = Date.now();
  return inReadOnlyTx(database, async (client) => {
    const res = await client.query(sql);
    const rows = res.rows as Record<string, unknown>[];
    const truncated = g.wrappable && rows.length > max;
    return {
      columns: res.fields.map((f) => f.name),
      rows: truncated ? rows.slice(0, max) : rows,
      row_count: truncated ? max : rows.length,
      truncated,
      duration_ms: Date.now() - start,
    };
  });
}

/** Internal, parameterised, trusted SQL (e.g. bo_find_member). Still READ ONLY. */
export async function queryRows<R extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[],
  database?: string,
): Promise<R[]> {
  return inReadOnlyTx(database, async (client) => (await client.query<R>(sql, params)).rows);
}

export interface DatabaseInfo {
  name: string;
  size: string;
}

export async function listDatabases(): Promise<DatabaseInfo[]> {
  const res = await (await getPool()).query<DatabaseInfo>(
    `SELECT datname AS name, pg_size_pretty(pg_database_size(datname)) AS size
     FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname`,
  );
  return res.rows;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: "table" | "view" | "materialized view" | "foreign table" | "partitioned table";
  estimated_rows: number | null;
}

export async function listTables(schema: string, pattern?: string, database?: string): Promise<TableInfo[]> {
  const res = await (await getPool(database)).query<{
    schema: string;
    name: string;
    relkind: string;
    estimated_rows: string | null;
  }>(
    `
    SELECT n.nspname AS schema,
           c.relname AS name,
           c.relkind,
           NULLIF(c.reltuples, -1)::bigint::text AS estimated_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
      AND c.relkind IN ('r','v','m','f','p')
      AND ($2::text IS NULL OR c.relname ILIKE $2)
    ORDER BY c.relname
    `,
    [schema, pattern ?? null],
  );
  const kinds: Record<string, TableInfo["kind"]> = {
    r: "table",
    v: "view",
    m: "materialized view",
    f: "foreign table",
    p: "partitioned table",
  };
  return res.rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    kind: kinds[r.relkind] ?? "table",
    estimated_rows: r.estimated_rows === null ? null : Number(r.estimated_rows),
  }));
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primary_key: boolean;
}

export interface TableDescription {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  indexes: { name: string; definition: string }[];
  foreign_keys: { name: string; columns: string[]; references: string }[];
}

export async function describeTable(schema: string, table: string, database?: string): Promise<TableDescription | null> {
  const pool = await getPool(database);
  const exists = await pool.query(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','v','m','f','p')`,
    [schema, table],
  );
  if (exists.rowCount === 0) return null;

  const [cols, idx, fks] = await Promise.all([
    pool.query<ColumnInfo>(
      `
      SELECT a.attname AS name,
             format_type(a.atttypid, a.atttypmod) AS type,
             NOT a.attnotnull AS nullable,
             pg_get_expr(d.adbin, d.adrelid) AS "default",
             COALESCE(bool_or(con.contype = 'p'), false) AS primary_key
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN pg_constraint con ON con.conrelid = a.attrelid AND a.attnum = ANY(con.conkey) AND con.contype = 'p'
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      GROUP BY a.attnum, a.attname, a.atttypid, a.atttypmod, a.attnotnull, d.adbin, d.adrelid
      ORDER BY a.attnum
      `,
      [schema, table],
    ),
    pool.query<{ name: string; definition: string }>(
      `SELECT indexname AS name, indexdef AS definition
       FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
      [schema, table],
    ),
    pool.query<{ name: string; columns: string[]; references: string }>(
      `
      SELECT con.conname AS name,
             ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                   ORDER BY k.ord) AS columns,
             pg_get_constraintdef(con.oid) AS references
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'f'
      ORDER BY con.conname
      `,
      [schema, table],
    ),
  ]);

  return { schema, name: table, columns: cols.rows, indexes: idx.rows, foreign_keys: fks.rows };
}

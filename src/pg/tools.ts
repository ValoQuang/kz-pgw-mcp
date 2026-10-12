/** Read-only Postgres MCP tools: query, list tables/databases, describe table. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { pg as cfg } from "../core/config.js";
import { HINTS, ROWS, TOOLS } from "../core/constants.js";
import { fail, note, ok, safely, type ToolResult } from "../core/result.js";
import { describeTable, listDatabases, listTables, runReadOnly } from "./db.js";
import { formatPgError } from "./errors.js";

/** Postgres identifier length limit. */
const PG_NAME_MAX = 63;

/** Every pg tool maps errors through formatPgError. */
const pgSafely = <A>(fn: (args: A) => Promise<ToolResult>) => safely(fn, formatPgError);

export function registerPgTools(server: McpServer): void {
  const label = cfg.label();
  const defaultDb = cfg.database();
  const timeout = cfg.timeoutMs();

  const schemaArg = z.string().min(1).max(PG_NAME_MAX).default("public").describe("Schema name");

  const databaseArg = z
    .string()
    .min(1)
    .max(PG_NAME_MAX)
    .regex(/^[A-Za-z0-9_-]+$/, "database name: letters, digits, _ or - only")
    .default(defaultDb)
    .describe(`Database on the cluster. One per account, e.g. kz-tpg1, kz-tco. Default "${defaultDb}". Use ${TOOLS.pgListDatabases} to see all.`);

  server.registerTool(
    TOOLS.pgQuery,
    {
      title: "Run read-only SQL",
      description: `Run one read-only SQL statement against ${label} and return rows as JSON.

Rules:
  - One statement only. SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE.
  - Runs inside a READ ONLY transaction with a ${timeout} ms timeout. Any write fails.
  - Row-returning queries are capped at max_rows (default ${ROWS.default}, hard max ${ROWS.hardMax}). 'truncated: true' means more rows exist; add WHERE/ORDER BY/OFFSET to page.
  - Column names in this DB are camelCase; quote them: "createdAt", "memberId".
  - bigint/numeric/timestamps are returned as strings.

Args:
  - sql (string): the statement
  - database (string, optional): which DB on the cluster, e.g. "kz-tpg1". Default "${defaultDb}".
  - max_rows (number, optional): 1..${ROWS.hardMax}, default ${ROWS.default}

Returns: { columns: string[], rows: object[], row_count, truncated, duration_ms }

Use ${TOOLS.pgListTables} / ${TOOLS.pgDescribeTable} first when unsure of names.`,
      inputSchema: {
        sql: z.string().min(1).max(20_000).describe("One read-only SQL statement"),
        database: databaseArg,
        max_rows: z.number().int().min(1).max(ROWS.hardMax).default(ROWS.default).describe(`Row cap, 1..${ROWS.hardMax}`),
      },
      annotations: HINTS.read,
    },
    pgSafely(async ({ sql, database, max_rows }) => ok({ database, ...(await runReadOnly(sql, max_rows, database)) })),
  );

  server.registerTool(
    TOOLS.pgListTables,
    {
      title: "List tables",
      description: `List tables, views and materialized views in a schema of ${label}.

Args:
  - database (string, optional): e.g. "kz-tpg1". Default "${defaultDb}".
  - schema (string, optional): default "public"
  - pattern (string, optional): ILIKE pattern, e.g. "%member%"

Returns: { schema, count, tables: [{ schema, name, kind, estimated_rows }] }
estimated_rows comes from pg_class.reltuples (planner estimate, may be stale or null).`,
      inputSchema: {
        database: databaseArg,
        schema: schemaArg,
        pattern: z.string().max(200).optional().describe("ILIKE filter on table name, e.g. %ledger%"),
      },
      annotations: HINTS.read,
    },
    pgSafely(async ({ database, schema, pattern }) => {
      const tables = await listTables(schema, pattern, database);
      if (tables.length === 0) {
        return note(`No tables in ${database}.${schema}${pattern ? ` matching '${pattern}'` : ""}. Try another database, schema or pattern.`);
      }
      return ok({ database, schema, count: tables.length, tables });
    }),
  );

  server.registerTool(
    TOOLS.pgDescribeTable,
    {
      title: "Describe table",
      description: `Columns, types, defaults, primary key, indexes and foreign keys for one table in ${label}.

Args:
  - table (string): table name, case-sensitive, no quotes
  - database (string, optional): e.g. "kz-tpg1". Default "${defaultDb}".
  - schema (string, optional): default "public"

Returns: { schema, name, columns: [{ name, type, nullable, default, primary_key }], indexes: [{ name, definition }], foreign_keys: [{ name, columns, references }] }`,
      inputSchema: {
        table: z.string().min(1).max(PG_NAME_MAX).describe("Table name (case-sensitive)"),
        database: databaseArg,
        schema: schemaArg,
      },
      annotations: HINTS.read,
    },
    pgSafely(async ({ table, database, schema }) => {
      const d = await describeTable(schema, table, database);
      if (!d) {
        return fail(`Table '${schema}.${table}' not found in database '${database}'. Use ${TOOLS.pgListTables} with a pattern, or check the database name.`);
      }
      return ok({ database, ...d });
    }),
  );

  server.registerTool(
    TOOLS.pgListDatabases,
    {
      title: "List databases",
      description: `List databases on the ${label} cluster. One database per account (kz-tpg1, kz-tco, ...). Pass the name as 'database' to the other tools.

Returns: { count, databases: [{ name, size }] }`,
      inputSchema: {},
      annotations: HINTS.read,
    },
    pgSafely(async () => {
      const databases = await listDatabases();
      return ok({ count: databases.length, databases });
    }),
  );
}

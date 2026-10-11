import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { pg as cfg } from "../config.js";
import { fail, ok, type ToolResult } from "../result.js";
import { DEFAULT_MAX_ROWS, HARD_MAX_ROWS, describeTable, listDatabases, listTables, runReadOnly } from "./db.js";
import { formatPgError } from "./errors.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerPgTools(server: McpServer): void {
  const label = cfg.label();
  const defaultDb = cfg.database();
  const timeout = cfg.timeoutMs();

  const databaseArg = z
    .string()
    .min(1)
    .max(63)
    .regex(/^[A-Za-z0-9_-]+$/, "database name: letters, digits, _ or - only")
    .default(defaultDb)
    .describe(`Database on the cluster. One per account, e.g. kz-tpg1, kz-tco. Default "${defaultDb}". Use pg_list_databases to see all.`);

  server.registerTool(
    "pg_query",
    {
      title: "Run read-only SQL",
      description: `Run one read-only SQL statement against ${label} and return rows as JSON.

Rules:
  - One statement only. SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE.
  - Runs inside a READ ONLY transaction with a ${timeout} ms timeout. Any write fails.
  - Row-returning queries are capped at max_rows (default ${DEFAULT_MAX_ROWS}, hard max ${HARD_MAX_ROWS}). 'truncated: true' means more rows exist; add WHERE/ORDER BY/OFFSET to page.
  - Column names in this DB are camelCase; quote them: "createdAt", "memberId".
  - bigint/numeric/timestamps are returned as strings.

Args:
  - sql (string): the statement
  - database (string, optional): which DB on the cluster, e.g. "kz-tpg1". Default "${defaultDb}".
  - max_rows (number, optional): 1..${HARD_MAX_ROWS}, default ${DEFAULT_MAX_ROWS}

Returns: { columns: string[], rows: object[], row_count, truncated, duration_ms }

Use pg_list_tables / pg_describe_table first when unsure of names.`,
      inputSchema: {
        sql: z.string().min(1).max(20_000).describe("One read-only SQL statement"),
        database: databaseArg,
        max_rows: z.number().int().min(1).max(HARD_MAX_ROWS).default(DEFAULT_MAX_ROWS).describe(`Row cap, 1..${HARD_MAX_ROWS}`),
      },
      annotations: RO,
    },
    async ({ sql, database, max_rows }): Promise<ToolResult> => {
      try {
        return ok({ database, ...(await runReadOnly(sql, max_rows, database)) });
      } catch (e) {
        return fail(formatPgError(e));
      }
    },
  );

  server.registerTool(
    "pg_list_tables",
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
        schema: z.string().min(1).max(63).default("public").describe("Schema name"),
        pattern: z.string().max(200).optional().describe("ILIKE filter on table name, e.g. %ledger%"),
      },
      annotations: RO,
    },
    async ({ database, schema, pattern }): Promise<ToolResult> => {
      try {
        const tables = await listTables(schema, pattern, database);
        if (tables.length === 0) {
          return {
            content: [{ type: "text", text: `No tables in ${database}.${schema}${pattern ? ` matching '${pattern}'` : ""}. Try another database, schema or pattern.` }],
          };
        }
        return ok({ database, schema, count: tables.length, tables });
      } catch (e) {
        return fail(formatPgError(e));
      }
    },
  );

  server.registerTool(
    "pg_describe_table",
    {
      title: "Describe table",
      description: `Columns, types, defaults, primary key, indexes and foreign keys for one table in ${label}.

Args:
  - table (string): table name, case-sensitive, no quotes
  - database (string, optional): e.g. "kz-tpg1". Default "${defaultDb}".
  - schema (string, optional): default "public"

Returns: { schema, name, columns: [{ name, type, nullable, default, primary_key }], indexes: [{ name, definition }], foreign_keys: [{ name, columns, references }] }`,
      inputSchema: {
        table: z.string().min(1).max(63).describe("Table name (case-sensitive)"),
        database: databaseArg,
        schema: z.string().min(1).max(63).default("public").describe("Schema name"),
      },
      annotations: RO,
    },
    async ({ table, database, schema }): Promise<ToolResult> => {
      try {
        const d = await describeTable(schema, table, database);
        if (!d) {
          return fail(`Table '${schema}.${table}' not found in database '${database}'. Use pg_list_tables with a pattern, or check the database name.`);
        }
        return ok({ database, ...d });
      } catch (e) {
        return fail(formatPgError(e));
      }
    },
  );

  server.registerTool(
    "pg_list_databases",
    {
      title: "List databases",
      description: `List databases on the ${label} cluster. One database per account (kz-tpg1, kz-tco, ...). Pass the name as 'database' to the other tools.

Returns: { count, databases: [{ name, size }] }`,
      inputSchema: {},
      annotations: RO,
    },
    async (): Promise<ToolResult> => {
      try {
        const databases = await listDatabases();
        return ok({ count: databases.length, databases });
      } catch (e) {
        return fail(formatPgError(e));
      }
    },
  );
}

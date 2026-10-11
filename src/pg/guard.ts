/**
 * Read-only SQL guard.
 *
 * First line of defence. The DB-level `SET TRANSACTION READ ONLY` is the
 * second. Both must pass.
 */

const ALLOWED_FIRST_KEYWORDS = new Set([
  "select",
  "with",
  "explain",
  "show",
  "values",
  "table",
]);

/**
 * Keywords/functions that may hide inside a CTE or subquery and must never
 * run. Statement-level keywords (BEGIN, SET, DO, ...) are already blocked by
 * the first-keyword check. `\b` treats `_` as a word char, so snake_case
 * columns like `updated_at` and camelCase like `updatedAt` do not match.
 */
const FORBIDDEN_ANYWHERE =
  /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|vacuum|analyze|cluster|reindex|refresh|lock|set_config|pg_sleep|pg_terminate_backend|pg_cancel_backend|lo_import|lo_export|dblink|pg_read_file|pg_read_binary_file|pg_ls_dir)\b/i;

export interface GuardResult {
  ok: boolean;
  sql: string;
  reason?: string;
  /** True when the statement is a row-returning query that can be LIMIT-wrapped. */
  wrappable: boolean;
}

/** Remove -- and /* *\/ comments, but leave string literals alone. */
export function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        out += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        out += c;
        i++;
      }
      continue;
    }
    if (inSingle) {
      out += c;
      if (c === "'" ) inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      out += c;
      if (c === '"') inDouble = false;
      i++;
      continue;
    }

    if (c === "'") {
      inSingle = true;
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      out += c;
      i++;
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = m[0];
        out += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Count statement separators outside strings. */
function countSemicolons(sql: string): number {
  let n = 0;
  let inSingle = false;
  let inDouble = false;
  let dollarTag: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = m[0];
        i += dollarTag.length - 1;
      }
    } else if (c === ";") n++;
  }
  return n;
}

/** Blank out string literals so keyword scanning ignores their content. */
function blankStrings(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export function guardSql(raw: string): GuardResult {
  let sql = stripComments(raw).trim();
  // Drop one trailing semicolon.
  sql = sql.replace(/;\s*$/, "").trim();

  if (!sql) {
    return { ok: false, sql, wrappable: false, reason: "Empty SQL." };
  }
  if (countSemicolons(sql) > 0) {
    return {
      ok: false,
      sql,
      wrappable: false,
      reason: "Only one statement per call. Remove extra ';'.",
    };
  }

  const first = (/^[A-Za-z]+/.exec(sql)?.[0] ?? "").toLowerCase();
  if (!ALLOWED_FIRST_KEYWORDS.has(first)) {
    return {
      ok: false,
      sql,
      wrappable: false,
      reason: `Read-only server. Statement must start with SELECT, WITH, EXPLAIN, SHOW, VALUES or TABLE. Got '${first || sql.slice(0, 20)}'.`,
    };
  }

  const scan = blankStrings(sql);
  const bad = FORBIDDEN_ANYWHERE.exec(scan);
  if (bad) {
    // `analyze` is fine inside EXPLAIN (ANALYZE) only when not a write; but
    // EXPLAIN ANALYZE executes the statement, which is still read-only here.
    const kw = bad[1].toLowerCase();
    const explainAnalyze = first === "explain" && kw === "analyze";
    if (!explainAnalyze) {
      return {
        ok: false,
        sql,
        wrappable: false,
        reason: `Read-only server. Keyword '${bad[1]}' is not allowed.`,
      };
    }
  }

  const wrappable = first === "select" || first === "with" || first === "values" || first === "table";
  return { ok: true, sql, wrappable };
}

/** Wrap a row-returning query so Postgres stops after max+1 rows. */
export function limitWrap(sql: string, max: number): string {
  return `SELECT * FROM (\n${sql}\n) AS _q LIMIT ${max + 1}`;
}

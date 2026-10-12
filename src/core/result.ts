/** MCP tool results: ok / fail shapes, size cap, and the try/catch wrapper every tool uses. */

import { CHARACTER_LIMIT } from "./constants.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const textResult = (text: string, structuredContent?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
});

export function ok(data: unknown): ToolResult {
  const obj: Record<string, unknown> =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };
  let text = JSON.stringify(obj, null, 2);
  if (text.length <= CHARACTER_LIMIT) return textResult(text, obj);

  const rows = Array.isArray(obj.rows) ? (obj.rows as unknown[]) : null;
  if (rows && rows.length > 1) {
    let keep = rows.length;
    let trimmed = obj;
    while (text.length > CHARACTER_LIMIT && keep > 1) {
      keep = Math.floor(keep / 2);
      trimmed = {
        ...obj,
        rows: rows.slice(0, keep),
        row_count: keep,
        truncated: true,
        truncation_note: `Response trimmed to ${keep} of ${rows.length} rows to fit ${CHARACTER_LIMIT} chars. Select fewer columns or add WHERE/LIMIT.`,
      };
      text = JSON.stringify(trimmed, null, 2);
    }
    return textResult(text, trimmed);
  }
  return textResult(text.slice(0, CHARACTER_LIMIT) + `\n... [truncated at ${CHARACTER_LIMIT} chars]`);
}

/** Plain text, not an error (e.g. "no rows matched"). */
export const note = (text: string): ToolResult => textResult(text);

export function fail(message: string): ToolResult {
  const text = /^(Error|Rejected)/.test(message) ? message : `Error: ${message}`;
  return { ...textResult(text), isError: true };
}

/** Wrap a tool handler: thrown errors become fail(format(e)). */
export function safely<A>(
  fn: (args: A) => Promise<ToolResult>,
  format: (e: unknown) => string = errorMessage,
): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(format(e));
    }
  };
}

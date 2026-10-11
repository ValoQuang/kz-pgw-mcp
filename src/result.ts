export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export const CHARACTER_LIMIT = 40_000;

export function ok(data: unknown): ToolResult {
  const obj: Record<string, unknown> =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };
  let text = JSON.stringify(obj, null, 2);
  if (text.length <= CHARACTER_LIMIT) return { content: [{ type: "text", text }], structuredContent: obj };

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
    return { content: [{ type: "text", text }], structuredContent: trimmed };
  }
  text = text.slice(0, CHARACTER_LIMIT) + `\n... [truncated at ${CHARACTER_LIMIT} chars]`;
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message.startsWith("Error") || message.startsWith("Rejected") ? message : `Error: ${message}` }], isError: true };
}

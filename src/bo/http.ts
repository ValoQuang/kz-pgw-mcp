/** JSON over fetch. Parses the body even on errors so the message shows what the API said. */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function requestJson<T>(
  method: HttpMethod,
  url: string,
  opts: { body?: unknown; headers?: Record<string, string>; timeoutMs: number; errorChars?: number },
): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(hasBody ? { "Content-Type": "application/json" } : {}), ...opts.headers },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(data).slice(0, opts.errorChars ?? 1000)}`);
  return data as T;
}

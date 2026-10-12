/** Authenticated kz-api call for one group, using the cached session token. */

import { apiBase } from "../core/config.js";
import { TIMEOUT_MS } from "../core/constants.js";
import { bearer } from "./auth.js";
import { requestJson, type HttpMethod } from "./http.js";

export async function apiCall<T = unknown>(group: string, method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const url = `${apiBase(group)}${path.startsWith("/") ? path : `/${path}`}`;
  return requestJson<T>(method, url, {
    body,
    headers: { Authorization: `Bearer ${await bearer(group)}` },
    timeoutMs: TIMEOUT_MS.boApi,
  });
}

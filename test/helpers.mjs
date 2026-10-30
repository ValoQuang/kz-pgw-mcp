// Shared setup for node:test files. Each file runs in its own process, so env set here
// applies before any dist/ module reads it. Import this first.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tmp = mkdtempSync(join(tmpdir(), "kz-pgw-test-"));

// Never read or write the real ~/.config/kz-pgw or ~/.claude.
for (const k of Object.keys(process.env)) if (/^(KZ_|PG|SSH_)/.test(k)) delete process.env[k];
process.env.KZ_PGW_CONFIG = join(tmp, "config.env");
process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
process.env.KZ_SKILLS_DIR = "off";

export const dist = (p) => new URL(`../dist/${p}`, import.meta.url).href;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Replace global fetch. `route(req)` returns [status, body]; every call is recorded.
 * req = { method, url, body, headers }.
 */
export function mockFetch(route) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const req = {
      method: init.method ?? "GET",
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
    };
    calls.push(req);
    const [status, body] = route(req);
    return json(status, body);
  };
  return calls;
}

const nowS = () => Math.floor(Date.now() / 1000);

/** Token body as kz-api returns it. Offsets in seconds from now. */
export function token(name, { expiresIn = 3600, refreshIn = 86_400 } = {}) {
  return {
    token_type: "Bearer",
    access_token: `access-${name}`,
    refresh_token: `refresh-${name}`,
    expires_in: expiresIn,
    expires_at: nowS() + expiresIn,
    refresh_expires_at: nowS() + refreshIn,
  };
}

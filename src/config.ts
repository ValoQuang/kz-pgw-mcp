/**
 * Config. Sources, highest priority first:
 *   1. process.env (Claude Desktop .mcpb user_config, shell, .mcp.json env)
 *   2. $KZ_PGW_CONFIG (explicit file path)
 *   3. ~/.config/kz-pgw/.env   (written by `kz-pgw-mcp init`)
 *   4. <package>/.env           (dev only)
 *
 * Nothing here throws at import. Missing values surface per-tool via
 * requireBo() / requirePg() so the server still starts and tells the user
 * what to run.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG = "@valoquang/kz-pgw-mcp";
export const INIT_CMD = `npx -y ${PKG} init`;

export const CONFIG_DIR = join(homedir(), ".config", "kz-pgw");
export const CONFIG_FILE = process.env.KZ_PGW_CONFIG ?? join(CONFIG_DIR, ".env");

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadInto(path: string): boolean {
  if (!existsSync(path)) return false;
  const vars = parseEnvFile(readFileSync(path, "utf8"));
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
  }
  return true;
}

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const loadedFrom: string[] = [];
for (const p of [CONFIG_FILE, join(PKG_ROOT, ".env")]) {
  if (loadInto(p)) loadedFrom.push(p);
}

// ---------- accessors ----------

export class ConfigError extends Error {}

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};

export const BO_KEYS = ["KZ_USERNAME", "KZ_PASSWORD"] as const;
export const PG_KEYS = ["PGHOST", "PGUSER", "PGPASSWORD"] as const;

export function missing(keys: readonly string[]): string[] {
  return keys.filter((k) => !env(k));
}

function needs(keys: readonly string[], what: string): void {
  const m = missing(keys);
  if (m.length) {
    throw new ConfigError(
      `${what} not configured: missing ${m.join(", ")}. Run \`${INIT_CMD}\` (writes ${CONFIG_FILE}) or set them as env vars.`,
    );
  }
}

/** Backoffice API */
export const bo = {
  stagingDomain: (): string => env("KZ_STAGING_DOMAIN") ?? "trykz.dev",
  credentials(): { username: string; password: string } {
    needs(BO_KEYS, "Backoffice login");
    return { username: env("KZ_USERNAME")!, password: env("KZ_PASSWORD")! };
  },
  /** KZ_TOTP_SECRET_<GROUP>, base32. Undefined → ask user for the code. */
  totpSecret: (group: string): string | undefined => env(`KZ_TOTP_SECRET_${group.toUpperCase()}`),
  /** Write tools (deposit, withdraw, non-GET bo_api) are off unless KZ_PGW_ALLOW_WRITES=true */
  allowWrites: (): boolean => /^(1|true|yes)$/i.test(env("KZ_PGW_ALLOW_WRITES") ?? ""),
};

/** Postgres */
export const pg = {
  check: (): void => needs(PG_KEYS, "Staging DB"),
  host: (): string => env("PGHOST") ?? "localhost",
  port: (): number => Number(env("PGPORT") ?? 5432),
  database: (): string => env("PGDATABASE") ?? "postgres",
  sslMode: (): string => (env("PGSSLMODE") ?? "").toLowerCase(),
  label: (): string => env("PG_MCP_LABEL") ?? `${env("PGDATABASE") ?? "?"}@${env("PGHOST") ?? "?"}`,
  timeoutMs: (): number => Number(env("PG_MCP_TIMEOUT_MS") ?? 30_000),
  vpnApp: (): string => process.env.PG_MCP_VPN_APP ?? "NordLayer",
  vpnGateway: (): string => env("PG_MCP_VPN_GATEWAY") ?? "s5tech-VPS",
  /** Group → database name. kz-{group} by default. */
  databaseForGroup: (group: string): string => (env("KZ_PG_DB_TEMPLATE") ?? "kz-{group}").replace("{group}", group),
};

export const GROUP_RE = /^t[a-z]{2}\d?$/;

export function assertGroup(group: string): string {
  const g = group.trim().toLowerCase();
  if (!GROUP_RE.test(g)) throw new Error(`Invalid group "${group}". Expected pattern like tpg1, ttg1, tth1, tco.`);
  return g;
}

export function apiBase(group: string): string {
  return `https://api.${assertGroup(group)}.${bo.stagingDomain()}`;
}

/** Snapshot for `doctor` / `init` display. Secrets masked. */
export function summary(): Record<string, string> {
  const show = (k: string, secret = false): string => {
    const v = env(k);
    if (!v) return "(unset)";
    return secret ? "***" : v;
  };
  return {
    KZ_USERNAME: show("KZ_USERNAME"),
    KZ_PASSWORD: show("KZ_PASSWORD", true),
    KZ_STAGING_DOMAIN: bo.stagingDomain(),
    KZ_PGW_ALLOW_WRITES: String(bo.allowWrites()),
    PGHOST: show("PGHOST"),
    PGPORT: String(pg.port()),
    PGDATABASE: pg.database(),
    PGUSER: show("PGUSER"),
    PGPASSWORD: show("PGPASSWORD", true),
    PGSSLMODE: show("PGSSLMODE"),
    SSH_HOST: show("SSH_HOST"),
    SSH_USER: show("SSH_USER"),
    SSH_PASSWORD: show("SSH_PASSWORD", true),
    SSH_KEY_PATH: show("SSH_KEY_PATH"),
  };
}

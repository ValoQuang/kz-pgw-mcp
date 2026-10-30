/**
 * Config. Sources, highest priority first:
 *   1. process.env (Claude Desktop .mcpb user_config, shell, .mcp.json env)
 *   2. $KZ_PGW_CONFIG (explicit file path)
 *   3. ~/.config/kz-pgw/.env   (written by `kz-pgw-mcp init`)
 *   4. <package>/.env           (dev only)
 *
 * Nothing here throws at import. Missing values surface per-tool via
 * bo.credentials() / pg.check() so the server still starts and tells the user
 * what to run.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CLI, GROUP_HINT, GROUP_RE } from "./constants.js";
import { ENV_KEYS, get, isSecret, missing, parseEnvFile, raw, totpKey, type EnvKey } from "./env.js";
import { CONFIG_FILE, DEFAULT_SKILLS_DIR, PKG_ENV_FILE, expandHome } from "./paths.js";

function loadInto(path: string): boolean {
  if (!existsSync(path)) return false;
  for (const [k, v] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
    if (!process.env[k]) process.env[k] = v;
  }
  return true;
}

export const loadedFrom: string[] = [CONFIG_FILE, PKG_ENV_FILE].filter(loadInto);

// ---------- accessors ----------

export class ConfigError extends Error {}

export const BO_KEYS = ["KZ_USERNAME", "KZ_PASSWORD"] as const satisfies readonly EnvKey[];
export const PG_KEYS = ["PGHOST", "PGUSER", "PGPASSWORD"] as const satisfies readonly EnvKey[];

function needs(keys: readonly EnvKey[], what: string): void {
  const m = missing(keys);
  if (m.length) {
    throw new ConfigError(
      `${what} not configured: missing ${m.join(", ")}. Run \`${CLI.init}\` (writes ${CONFIG_FILE}) or set them as env vars.`,
    );
  }
}

const isTrue = (v: string | undefined): boolean => /^(1|true|yes)$/i.test(v ?? "");

/** Who uses the server. project = backoffice API only. dev = backoffice + staging DB. */
export const ROLES = ["project", "dev"] as const;
export type Role = (typeof ROLES)[number];

export const role = {
  /** Undefined until the user picks one (init, .mcpb form, or kz_set_role). */
  get: (): Role | undefined => {
    const v = raw("KZ_ROLE")?.toLowerCase();
    return (ROLES as readonly string[]).includes(v ?? "") ? (v as Role) : undefined;
  },
  isProject: (): boolean => role.get() === "project",
};

/** Backoffice API */
export const bo = {
  stagingDomain: (): string => get("KZ_STAGING_DOMAIN")!,
  credentials(): { username: string; password: string } {
    needs(BO_KEYS, "Backoffice login");
    return { username: raw("KZ_USERNAME")!, password: raw("KZ_PASSWORD")! };
  },
  /** Base32. Undefined → ask user for the code. */
  totpSecret: (group: string): string | undefined => raw(totpKey(group)),
  /** Write tools (deposit, withdraw, non-GET bo_api) are off unless KZ_PGW_ALLOW_WRITES=true */
  allowWrites: (): boolean => isTrue(get("KZ_PGW_ALLOW_WRITES")),
};

/** Postgres */
export const pg = {
  check: (): void => needs(PG_KEYS, "Staging DB"),
  host: (): string => get("PGHOST") ?? "localhost",
  port: (): number => Number(get("PGPORT")),
  database: (): string => get("PGDATABASE")!,
  user: (): string | undefined => raw("PGUSER"),
  password: (): string | undefined => raw("PGPASSWORD"),
  sslMode: (): string => (get("PGSSLMODE") ?? "").toLowerCase(),
  label: (): string => get("PG_MCP_LABEL") ?? `${raw("PGDATABASE") ?? "?"}@${raw("PGHOST") ?? "?"}`,
  timeoutMs: (): number => Number(get("PG_MCP_TIMEOUT_MS")),
  vpnApp: (): string => get("PG_MCP_VPN_APP")!,
  vpnGateway: (): string => get("PG_MCP_VPN_GATEWAY")!,
  /** Group → database name. kz-{group} by default. */
  databaseForGroup: (group: string): string => get("KZ_PG_DB_TEMPLATE")!.replace("{group}", group),
};

/** SSH jump host. Undefined host = direct connect. */
export const ssh = {
  host: (): string | undefined => raw("SSH_HOST"),
  port: (): number => Number(get("SSH_PORT")),
  user: (): string => get("SSH_USER")!,
  password: (): string | undefined => raw("SSH_PASSWORD"),
  keyPath: (): string | undefined => {
    const p = raw("SSH_KEY_PATH");
    return p ? expandHome(p) : undefined;
  },
  passphrase: (): string | undefined => raw("SSH_KEY_PASSPHRASE"),
};

/** Claude skills. KZ_SKILLS_DIR blank → ~/.claude/skills. "off" disables. "plugin" → the Claude Code plugin ships them. */
export const skills = {
  disabled: (): boolean => /^(0|off|false|no)$/i.test(raw("KZ_SKILLS_DIR") ?? ""),
  /** Set by the plugin's mcpServers env. Copies made by older versions are removed, nothing is copied. */
  fromPlugin: (): boolean => /^plugin$/i.test(raw("KZ_SKILLS_DIR") ?? ""),
  dir: (): string => {
    const v = raw("KZ_SKILLS_DIR");
    return v && !skills.fromPlugin() ? resolve(expandHome(v)) : DEFAULT_SKILLS_DIR;
  },
};

// ---------- groups ----------

export function assertGroup(group: string): string {
  const g = group.trim().toLowerCase();
  if (!GROUP_RE.test(g)) throw new Error(`Invalid group "${group}". Expected pattern like ${GROUP_HINT}.`);
  return g;
}

export function apiBase(group: string): string {
  return `https://api.${assertGroup(group)}.${bo.stagingDomain()}`;
}

/** Snapshot for `doctor`. Every registered var, defaults applied, secrets masked. */
export function summary(): Record<string, string> {
  const out = Object.fromEntries(
    ENV_KEYS.map((k) => {
      const v = get(k);
      return [k, v === undefined || v === "" ? "(unset)" : isSecret(k) ? "***" : v];
    }),
  );
  out.KZ_SKILLS_DIR = skills.disabled() ? "off" : skills.fromPlugin() ? "plugin" : skills.dir();
  return out;
}

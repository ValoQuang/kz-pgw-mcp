/**
 * Every env var the server reads. Single source for:
 *   - core/config.ts     typed accessors + defaults
 *   - commands/init.ts   the .env file it writes
 *   - commands/doctor.ts the config summary
 * Add a var here first.
 */

import { TOTP_SECRET_PREFIX } from "./constants.js";

export type Section = "bo" | "pg" | "ssh" | "vpn" | "skills";

/** Section order and headings in the written .env. */
export const SECTIONS: Record<Section, string> = {
  bo: "Backoffice (staging)",
  pg: "Staging Postgres (pgAdmin → kz-api-global → Properties → Connection)",
  ssh: "SSH tunnel (pgAdmin → SSH Tunnel tab). Empty SSH_HOST = direct connect",
  vpn: "VPN nudge (macOS)",
  skills: "Claude skills (kz-bo-login, kz-sql, kz-pgw-issue)",
};

interface Spec {
  section: Section;
  /** Comment written above the line in .env. */
  note?: string;
  /** Used when unset or blank. */
  def?: string;
  /** Masked in doctor / init preview. */
  secret?: boolean;
  /** "" is a real value (e.g. "" disables the VPN nudge), not "unset". */
  emptyIsValue?: boolean;
}

export const ENV = {
  KZ_USERNAME: { section: "bo", note: "Staff login, same for all groups" },
  KZ_PASSWORD: { section: "bo", secret: true },
  KZ_STAGING_DOMAIN: { section: "bo", def: "trykz.dev", note: "Group API = https://api.<group>.<domain>" },
  KZ_PGW_ALLOW_WRITES: {
    section: "bo",
    def: "false",
    note: "true → bo_create_deposit / bo_create_withdraw / non-GET bo_api enabled",
  },

  PGHOST: { section: "pg" },
  PGPORT: { section: "pg", def: "5432" },
  PGDATABASE: { section: "pg", def: "postgres", note: "Default database. One per group: kz-tpg1, kz-tco, ..." },
  PGUSER: { section: "pg" },
  PGPASSWORD: { section: "pg", secret: true },
  PGSSLMODE: { section: "pg", note: "require for RDS. disable/prefer → plain" },
  PG_MCP_LABEL: { section: "pg", note: "Shown in tool descriptions" },
  PG_MCP_TIMEOUT_MS: { section: "pg", def: "30000", note: "Statement timeout" },
  KZ_PG_DB_TEMPLATE: { section: "pg", def: "kz-{group}", note: "Database used by bo_find_member" },

  SSH_HOST: { section: "ssh" },
  SSH_PORT: { section: "ssh", def: "22" },
  SSH_USER: { section: "ssh", def: "ubuntu" },
  SSH_PASSWORD: { section: "ssh", secret: true },
  SSH_KEY_PATH: { section: "ssh", note: "Alternative to SSH_PASSWORD" },
  SSH_KEY_PASSPHRASE: { section: "ssh", secret: true },

  PG_MCP_VPN_APP: { section: "vpn", def: "NordLayer", emptyIsValue: true, note: 'App opened on connection error. "" disables' },
  PG_MCP_VPN_GATEWAY: { section: "vpn", def: "s5tech-VPS" },

  KZ_SKILLS_DIR: { section: "skills", note: "Where skills are copied. Blank = ~/.claude/skills. off = don't copy" },
} as const satisfies Record<string, Spec>;

export type EnvKey = keyof typeof ENV;
export const ENV_KEYS = Object.keys(ENV) as EnvKey[];

const spec = (k: string): Spec | undefined => (ENV as Record<string, Spec>)[k];

/** Trimmed value, or undefined when unset/blank. No default. */
export function raw(k: EnvKey | string): string | undefined {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
}

/** Registry default, if any. */
export const defaultOf = (k: EnvKey): string | undefined => spec(k)!.def;

/** Value with default applied. */
export function get(k: EnvKey): string | undefined {
  const s = spec(k)!;
  if (s.emptyIsValue && process.env[k] !== undefined) return process.env[k]!.trim();
  return raw(k) ?? defaultOf(k);
}

export const isSecret = (k: string): boolean => k.startsWith(TOTP_SECRET_PREFIX) || spec(k)?.secret === true;

export const totpKey = (group: string): string => `${TOTP_SECRET_PREFIX}${group.toUpperCase()}`;

export function missing(keys: readonly EnvKey[]): EnvKey[] {
  return keys.filter((k) => !raw(k));
}

// ---------- .env file ----------

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let val = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(val)) val = val.slice(1, -1);
    out[line.slice(0, eq).trim()] = val;
  }
  return out;
}

/** Render a full .env grouped by SECTIONS. TOTP keys go under bo. mask → secrets as ***. */
export function renderEnvFile(v: Record<string, string>, header: string, mask = false): string {
  const line = (k: string, note?: string): string => {
    const val = v[k] ?? "";
    const shown = mask && val && isSecret(k) ? "***" : /[\s#"']/.test(val) ? JSON.stringify(val) : val;
    return `${note ? `# ${note}\n` : ""}${k}=${shown}`;
  };
  const totp = Object.keys(v).filter((k) => k.startsWith(TOTP_SECRET_PREFIX)).sort();

  const out = [`# ${header}`, ""];
  for (const [section, title] of Object.entries(SECTIONS) as [Section, string][]) {
    out.push(`# --- ${title} ---`);
    for (const k of ENV_KEYS.filter((key) => ENV[key].section === section)) out.push(line(k, spec(k)!.note));
    if (section === "bo" && totp.length) {
      out.push("# Base32 TOTP secret per group. Set → bo_login finishes 2FA itself.", ...totp.map((k) => line(k)));
    }
    out.push("");
  }
  return out.join("\n");
}

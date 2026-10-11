/**
 * Interactive setup. Writes ~/.config/kz-pgw/.env (chmod 600).
 * Existing values are shown as defaults so re-running only changes what you type.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CONFIG_FILE, PKG, parseEnvFile } from "./config.js";
import { close, confirm, input, password, select } from "./prompt.js";

type Vars = Record<string, string>;

function existing(): Vars {
  if (!existsSync(CONFIG_FILE)) return {};
  return parseEnvFile(readFileSync(CONFIG_FILE, "utf8"));
}

export function render(v: Vars): string {
  const line = (k: string, comment?: string): string => {
    const val = v[k] ?? "";
    const needsQuote = /[\s#"']/.test(val);
    return `${comment ? `# ${comment}\n` : ""}${k}=${needsQuote ? JSON.stringify(val) : val}`;
  };
  const totp = Object.keys(v)
    .filter((k) => k.startsWith("KZ_TOTP_SECRET_"))
    .sort()
    .map((k) => line(k));
  return [
    `# ${PKG} — written by \`kz-pgw-mcp init\`. Re-run to change.`,
    "",
    "# --- Backoffice (staging) ---",
    line("KZ_USERNAME", "Staff login, same for all groups"),
    line("KZ_PASSWORD"),
    line("KZ_STAGING_DOMAIN", "Group API = https://api.<group>.<domain>"),
    line("KZ_PGW_ALLOW_WRITES", "true → bo_create_deposit / bo_create_withdraw / non-GET bo_api enabled"),
    ...(totp.length ? ["# Base32 TOTP secret per group. Set → bo_login finishes 2FA itself.", ...totp] : []),
    "",
    "# --- Staging Postgres (pgAdmin → kz-api-global → Properties → Connection) ---",
    line("PGHOST"),
    line("PGPORT"),
    line("PGDATABASE", "Default database. One per group: kz-tpg1, kz-tco, ..."),
    line("PGUSER"),
    line("PGPASSWORD"),
    line("PGSSLMODE", "require for RDS. disable/prefer → plain"),
    line("PG_MCP_LABEL"),
    "",
    "# --- SSH tunnel (pgAdmin → SSH Tunnel tab). Empty SSH_HOST = direct connect ---",
    line("SSH_HOST"),
    line("SSH_PORT"),
    line("SSH_USER"),
    line("SSH_PASSWORD"),
    line("SSH_KEY_PATH", "Alternative to SSH_PASSWORD"),
    "",
    "# --- VPN nudge (macOS) ---",
    line("PG_MCP_VPN_APP", 'App opened on connection error. "" disables'),
    line("PG_MCP_VPN_GATEWAY"),
    "",
  ].join("\n");
}

async function text(v: Vars, key: string, message: string, opts: { def?: string; required?: boolean } = {}): Promise<void> {
  v[key] = await input(message, { default: v[key] || opts.def, required: opts.required });
}

async function secret(v: Vars, key: string, message: string, required = true): Promise<void> {
  const has = !!v[key];
  const val = await password(message, { keepIfEmpty: has, required });
  if (val) v[key] = val;
}

export async function init(args: string[]): Promise<void> {
  const v = existing();
  const yes = args.includes("--yes") || args.includes("-y");

  console.log(`\n${PKG} setup → ${CONFIG_FILE}\n`);
  if (Object.keys(v).length) console.log("Existing config found. Enter keeps the current value.\n");

  try {
    console.log("── Backoffice (staging) ──");
    await text(v, "KZ_USERNAME", "BO staff username", { required: true });
    await secret(v, "KZ_PASSWORD", "BO password");
    await text(v, "KZ_STAGING_DOMAIN", "Staging domain", { def: "trykz.dev" });
    v.KZ_PGW_ALLOW_WRITES = String(
      await confirm("Enable write tools (bo_create_deposit, bo_create_withdraw, non-GET bo_api)?", v.KZ_PGW_ALLOW_WRITES === "true"),
    );
    if (await confirm("Add a TOTP secret for a group (auto 2FA)?", false)) {
      for (;;) {
        const g = (await input("Group (e.g. tpg1)", { required: true })).toLowerCase();
        const s = await password(`Base32 TOTP secret for ${g}`, { required: true });
        v[`KZ_TOTP_SECRET_${g.toUpperCase()}`] = s.replace(/\s+/g, "");
        if (!(await confirm("Add another group?", false))) break;
      }
    }

    console.log("\n── Staging Postgres ──");
    await text(v, "PGHOST", "PGHOST", { required: true });
    await text(v, "PGPORT", "PGPORT", { def: "5432" });
    await text(v, "PGDATABASE", "Default database", { def: "kz-tpg1" });
    await text(v, "PGUSER", "PGUSER", { required: true });
    await secret(v, "PGPASSWORD", "PGPASSWORD");
    v.PGSSLMODE = await select(
      "PGSSLMODE",
      [
        { value: "require", name: "require (RDS / Cloud SQL)" },
        { value: "prefer", name: "prefer" },
        { value: "disable", name: "disable" },
        { value: "verify-full", name: "verify-full" },
      ],
      (v.PGSSLMODE as "require" | "prefer" | "disable" | "verify-full") || "require",
    );
    await text(v, "PG_MCP_LABEL", "Label shown in tool descriptions", { def: "kz-api-global (staging)" });

    console.log("\n── SSH tunnel ──");
    if (await confirm("Connect through an SSH jump host (like pgAdmin SSH Tunnel)?", !!v.SSH_HOST)) {
      await text(v, "SSH_HOST", "SSH_HOST", { required: true });
      await text(v, "SSH_PORT", "SSH_PORT", { def: "22" });
      await text(v, "SSH_USER", "SSH_USER", { def: "ubuntu" });
      const auth = await select(
        "SSH auth",
        [
          { value: "password", name: "password" },
          { value: "key", name: "private key file" },
          { value: "agent", name: "ssh-agent / default ~/.ssh key" },
        ],
        v.SSH_KEY_PATH ? "key" : v.SSH_PASSWORD ? "password" : "password",
      );
      if (auth !== "password") delete v.SSH_PASSWORD;
      if (auth !== "key") delete v.SSH_KEY_PATH;
      if (auth === "password") await secret(v, "SSH_PASSWORD", "SSH_PASSWORD");
      if (auth === "key") await text(v, "SSH_KEY_PATH", "SSH_KEY_PATH", { def: "~/.ssh/id_ed25519" });
    } else {
      for (const k of ["SSH_HOST", "SSH_PORT", "SSH_USER", "SSH_PASSWORD", "SSH_KEY_PATH"]) delete v[k];
    }

    console.log("\n── VPN ──");
    await text(v, "PG_MCP_VPN_APP", "VPN app to open on connection error (empty = off)", { def: "NordLayer" });
    await text(v, "PG_MCP_VPN_GATEWAY", "VPN gateway name", { def: "s5tech-VPS" });

    const out = render(v);
    if (!yes) {
      console.log("\n" + out.replace(/^(KZ_PASSWORD|PGPASSWORD|SSH_PASSWORD|KZ_TOTP_SECRET_\w+)=.+$/gm, "$1=***"));
      if (!(await confirm(`Write ${CONFIG_FILE}?`, true))) {
        console.log("Aborted. Nothing written.");
        return;
      }
    }
    mkdirSync(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_FILE, out, { mode: 0o600 });
    chmodSync(CONFIG_FILE, 0o600);
    console.log(`\nWrote ${CONFIG_FILE} (600).`);
    console.log(`Next:  npx -y ${PKG} doctor     # test DB connection`);
    console.log(`       npx -y ${PKG} install    # add to Claude Desktop / Claude Code\n`);
  } finally {
    close();
  }
}

/**
 * `kz-pgw-mcp init`: interactive setup. Writes ~/.config/kz-pgw/.env (chmod 600).
 * Existing values are shown as defaults so re-running only changes what you type.
 * Keys, defaults and file layout come from core/env.ts.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CLI, PKG, TOOLS } from "../core/constants.js";
import { CONFIG_HEADER } from "../core/store.js";
import { ENV, ENV_KEYS, defaultOf, parseEnvFile, renderEnvFile, totpKey, type EnvKey } from "../core/env.js";
import { CONFIG_FILE, DEFAULT_SKILLS_DIR } from "../core/paths.js";
import { close, confirm, input, password, select } from "./prompt.js";

type Vars = Record<string, string>;

const HEADER = CONFIG_HEADER;
const SSH_KEYS = ENV_KEYS.filter((k) => ENV[k].section === "ssh");

function existing(): Vars {
  return existsSync(CONFIG_FILE) ? parseEnvFile(readFileSync(CONFIG_FILE, "utf8")) : {};
}

/** Prompt for a key. Default: current value → opts.def → registry default. */
async function text(v: Vars, key: EnvKey, message: string = key, opts: { def?: string; required?: boolean } = {}): Promise<void> {
  v[key] = await input(message, { default: v[key] || opts.def || defaultOf(key), required: opts.required });
}

async function secret(v: Vars, key: EnvKey, message: string = key, required = true): Promise<void> {
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
    console.log("── Role ──");
    v.KZ_ROLE = await select(
      "Who are you?",
      [
        { value: "project", name: "project — PA / QA / PM. Backoffice login only, no DB setup" },
        { value: "dev", name: "dev — backoffice + staging DB" },
      ],
      (v.KZ_ROLE as "project" | "dev") || "project",
    );
    const project = v.KZ_ROLE === "project";

    console.log("\n── Backoffice (staging) ──");
    await text(v, "KZ_USERNAME", "BO staff username", { required: true });
    await secret(v, "KZ_PASSWORD", "BO password");
    await text(v, "KZ_STAGING_DOMAIN", "Staging domain");
    v.KZ_PGW_ALLOW_WRITES = String(
      await confirm(`Enable write tools (${TOOLS.boCreateDeposit}, ${TOOLS.boCreateWithdraw}, non-GET ${TOOLS.boApi})?`, v.KZ_PGW_ALLOW_WRITES === "true"),
    );
    if (await confirm("Add a TOTP secret for a group (auto 2FA)?", false)) {
      for (;;) {
        const g = (await input("Group (e.g. tpg1)", { required: true })).toLowerCase();
        const s = await password(`Base32 TOTP secret for ${g}`, { required: true });
        v[totpKey(g)] = s.replace(/\s+/g, "");
        if (!(await confirm("Add another group?", false))) break;
      }
    }

    if (!project) {
      console.log("\n── Staging Postgres ──");
      await text(v, "PGHOST", undefined, { required: true });
      await text(v, "PGPORT");
      await text(v, "PGDATABASE", "Default database", { def: "kz-tpg1" });
      await text(v, "PGUSER", undefined, { required: true });
      await secret(v, "PGPASSWORD");
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
        await text(v, "SSH_HOST", undefined, { required: true });
        await text(v, "SSH_PORT");
        await text(v, "SSH_USER");
        const auth = await select(
          "SSH auth",
          [
            { value: "password", name: "password" },
            { value: "key", name: "private key file" },
            { value: "agent", name: "ssh-agent / default ~/.ssh key" },
          ],
          v.SSH_KEY_PATH ? "key" : "password",
        );
        if (auth !== "password") delete v.SSH_PASSWORD;
        if (auth !== "key") delete v.SSH_KEY_PATH;
        if (auth === "password") await secret(v, "SSH_PASSWORD");
        if (auth === "key") await text(v, "SSH_KEY_PATH", undefined, { def: "~/.ssh/id_ed25519" });
      } else {
        for (const k of SSH_KEYS) delete v[k];
      }
    }

    console.log("\n── VPN ──");
    await text(v, "PG_MCP_VPN_APP", "VPN app to open on connection error (empty = off)");
    await text(v, "PG_MCP_VPN_GATEWAY", "VPN gateway name");

    console.log("\n── Claude skills ──");
    v.KZ_SKILLS_DIR = await input(`Skills folder (blank = ${DEFAULT_SKILLS_DIR}, "off" = skip)`, { default: v.KZ_SKILLS_DIR });

    const out = renderEnvFile(v, HEADER);
    if (!yes) {
      console.log("\n" + renderEnvFile(v, HEADER, true));
      if (!(await confirm(`Write ${CONFIG_FILE}?`, true))) {
        console.log("Aborted. Nothing written.");
        return;
      }
    }
    mkdirSync(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_FILE, out, { mode: 0o600 });
    chmodSync(CONFIG_FILE, 0o600);
    console.log(`\nWrote ${CONFIG_FILE} (600).`);
    console.log(`Next:  ${CLI.doctor}     # check config${project ? "" : " + DB connection"}`);
    console.log(`       ${CLI.install}    # add to Claude Desktop / Claude Code\n`);
  } finally {
    close();
  }
}

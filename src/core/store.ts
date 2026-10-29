/** Persist one key into ~/.config/kz-pgw/.env (chmod 600) and apply it to this process. */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { PKG } from "./constants.js";
import { parseEnvFile, renderEnvFile, type EnvKey } from "./env.js";
import { CONFIG_FILE } from "./paths.js";

export const CONFIG_HEADER = `${PKG} — written by \`kz-pgw-mcp init\`. Re-run to change.`;

export function saveConfigValue(key: EnvKey, value: string): string {
  const v = existsSync(CONFIG_FILE) ? parseEnvFile(readFileSync(CONFIG_FILE, "utf8")) : {};
  v[key] = value;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, renderEnvFile(v, CONFIG_HEADER), { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
  process.env[key] = value;
  return CONFIG_FILE;
}

/** Filesystem locations. Package root, user config, Claude dirs. */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo / installed package root (parent of dist/ or src/). */
export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PKG_JSON = join(PKG_ROOT, "package.json");
/** Built CLI entry. Used by `install --local`. */
export const CLI_JS = join(PKG_ROOT, "dist", "cli.js");
/** Dev-only .env inside the checkout. */
export const PKG_ENV_FILE = join(PKG_ROOT, ".env");
/** Skills bundled with the package. */
export const BUNDLED_SKILLS_DIR = join(PKG_ROOT, "skills");

export const CONFIG_DIR = join(homedir(), ".config", "kz-pgw");
export const CONFIG_FILE = process.env.KZ_PGW_CONFIG ?? join(CONFIG_DIR, ".env");

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
export const DEFAULT_SKILLS_DIR = join(CLAUDE_DIR, "skills");

/** `~` or `~/x` → absolute. */
export function expandHome(p: string): string {
  return p.replace(/^~(?=$|[\\/])/, homedir());
}

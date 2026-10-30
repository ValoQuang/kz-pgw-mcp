/**
 * Copies the bundled skills/ into the Claude skills folder so Claude Code (and
 * the Desktop Code tab) load them next to this MCP's tools.
 *
 * Runs on `install` and on every server start. Only touches folders it owns
 * (SKILL_MARKER file). A user's own skill with the same name is never
 * overwritten. Skills dropped from the package are removed.
 *
 * Folder: KZ_SKILLS_DIR (blank → ~/.claude/skills). Opt out: KZ_SKILLS_DIR=off
 * KZ_SKILLS_DIR=plugin (set by the Claude Code plugin): the plugin loads skills/
 * itself, so nothing is copied and our old copies are removed (no duplicates).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { skills } from "../core/config.js";
import { SKILL_MARKER } from "../core/constants.js";
import { BUNDLED_SKILLS_DIR } from "../core/paths.js";
import { VERSION } from "../core/version.js";

export interface SkillSync {
  dir: string;
  installed: string[];
  upToDate: string[];
  skipped: string[];
  removed: string[];
}

const subdirs = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];

/** Version written by us, or undefined if the folder is not ours. */
const ownedVersion = (dir: string): string | undefined => {
  const m = join(dir, SKILL_MARKER);
  return existsSync(m) ? readFileSync(m, "utf8").trim() : undefined;
};

export function syncSkills(): SkillSync {
  const dir = skills.dir();
  const out: SkillSync = { dir, installed: [], upToDate: [], skipped: [], removed: [] };
  const bundled = skills.fromPlugin()
    ? []
    : subdirs(BUNDLED_SKILLS_DIR).filter((n) => existsSync(join(BUNDLED_SKILLS_DIR, n, "SKILL.md")));
  if (bundled.length) mkdirSync(dir, { recursive: true });

  for (const name of bundled) {
    const dest = join(dir, name);
    const owned = ownedVersion(dest);
    if (existsSync(dest) && owned === undefined) out.skipped.push(name);
    else if (owned === VERSION) out.upToDate.push(name);
    else {
      rmSync(dest, { recursive: true, force: true });
      cpSync(join(BUNDLED_SKILLS_DIR, name), dest, { recursive: true });
      writeFileSync(join(dest, SKILL_MARKER), VERSION + "\n");
      out.installed.push(name);
    }
  }

  for (const name of subdirs(dir)) {
    if (!bundled.includes(name) && ownedVersion(join(dir, name)) !== undefined) {
      rmSync(join(dir, name), { recursive: true, force: true });
      out.removed.push(name);
    }
  }
  return out;
}

/** Sync unless disabled. Never throws. One line per outcome. */
export function syncSkillsReport(): string[] {
  if (skills.disabled()) return ["off (KZ_SKILLS_DIR=off)"];
  try {
    const s = syncSkills();
    const lines = [
      s.installed.length && `installed ${s.installed.join(", ")} → ${s.dir}`,
      s.upToDate.length && `up to date: ${s.upToDate.join(", ")}`,
      s.removed.length && `removed old: ${s.removed.join(", ")}`,
      s.skipped.length && `skipped (you have your own copy): ${s.skipped.join(", ")}`,
    ].filter((l): l is string => !!l);
    if (lines.length) return lines;
    return [skills.fromPlugin() ? "loaded by the Claude Code plugin" : "none bundled"];
  } catch (e) {
    return [`sync failed (${(e as Error).message})`];
  }
}

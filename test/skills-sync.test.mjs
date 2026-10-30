import "./helpers.mjs";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { dist, tmp } from "./helpers.mjs";

const { syncSkills, syncSkillsReport } = await import(dist("skills/sync.js"));
const { VERSION } = await import(dist("core/version.js"));
const { SKILL_MARKER } = await import(dist("core/constants.js"));

const BUNDLED = readdirSync(new URL("../skills/", import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let n = 0;
/** Fresh skills dir with optional pre-existing folders: { name: markerVersion | null (user's own) }. */
function dirWith(existing = {}) {
  const dir = join(tmp, `skills-${n++}`);
  for (const [name, marker] of Object.entries(existing)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), "user copy\n");
    if (marker) writeFileSync(join(dir, name, SKILL_MARKER), marker + "\n");
  }
  process.env.KZ_SKILLS_DIR = dir;
  return dir;
}

test("first run copies every bundled skill with a version marker", () => {
  const dir = dirWith();
  const s = syncSkills();
  assert.deepEqual(s.installed.sort(), BUNDLED);
  for (const name of BUNDLED) assert.equal(readFileSync(join(dir, name, SKILL_MARKER), "utf8").trim(), VERSION);
});

test("second run is a no-op", () => {
  dirWith();
  syncSkills();
  const s = syncSkills();
  assert.deepEqual(s.upToDate.sort(), BUNDLED);
  assert.equal(s.installed.length, 0);
});

test("older owned copy is replaced", () => {
  const dir = dirWith({ [BUNDLED[0]]: "0.0.1" });
  const s = syncSkills();
  assert.ok(s.installed.includes(BUNDLED[0]));
  assert.notEqual(readFileSync(join(dir, BUNDLED[0], "SKILL.md"), "utf8"), "user copy\n");
});

test("user's own folder with the same name is never touched", () => {
  const dir = dirWith({ [BUNDLED[0]]: null });
  const s = syncSkills();
  assert.deepEqual(s.skipped, [BUNDLED[0]]);
  assert.equal(readFileSync(join(dir, BUNDLED[0], "SKILL.md"), "utf8"), "user copy\n");
});

test("owned skill dropped from the package is removed; unowned one stays", () => {
  const dir = dirWith({ "kz-bo-pgw": "0.1.0", "my-skill": null });
  const s = syncSkills();
  assert.deepEqual(s.removed, ["kz-bo-pgw"]);
  assert.ok(!existsSync(join(dir, "kz-bo-pgw")));
  assert.ok(existsSync(join(dir, "my-skill")));
});

test("KZ_SKILLS_DIR=plugin: nothing copied, old copies in ~/.claude/skills removed, user's kept", () => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "skills");
  mkdirSync(join(dir, "kz-guide"), { recursive: true });
  writeFileSync(join(dir, "kz-guide", SKILL_MARKER), "0.2.1\n");
  mkdirSync(join(dir, "kz-create-orders"), { recursive: true }); // user's own, no marker
  process.env.KZ_SKILLS_DIR = "plugin";

  const s = syncSkills();
  assert.equal(s.dir, dir);
  assert.deepEqual(s.installed, []);
  assert.deepEqual(s.removed, ["kz-guide"]);
  assert.ok(existsSync(join(dir, "kz-create-orders")));
  assert.deepEqual(syncSkillsReport(), ["loaded by the Claude Code plugin"]);
});

test("KZ_SKILLS_DIR=off: report says off, nothing happens", () => {
  process.env.KZ_SKILLS_DIR = "off";
  assert.deepEqual(syncSkillsReport(), ["off (KZ_SKILLS_DIR=off)"]);
});

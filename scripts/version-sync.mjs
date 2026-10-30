// Copies package.json "version" into manifest.json and the Claude Code plugin files.
// Runs from the npm `version` hook, so `npm version patch` bumps everything in one commit.
//   node scripts/version-sync.mjs           write
//   node scripts/version-sync.mjs --check   exit 1 if any file disagrees
import { readFileSync, writeFileSync } from "node:fs";

import { PKG_NAME, VERSION_FILES } from "./versions.mjs";

const root = new URL("../", import.meta.url);
const version = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version;
const check = process.argv.includes("--check");

let bad = 0;
for (const { file, get, set } of VERSION_FILES) {
  const url = new URL(file, root);
  const json = JSON.parse(readFileSync(url, "utf8"));
  const found = get(json);
  if (found.every((v) => v === version)) continue;
  if (check) {
    console.error(`${file}: ${found.join(", ")} ≠ package.json ${version}`);
    bad++;
    continue;
  }
  set(json, version);
  writeFileSync(url, JSON.stringify(json, null, 2) + "\n");
  console.log(`${file} → ${version}`);
}
if (bad) {
  console.error(`Run: node scripts/version-sync.mjs  (pins ${PKG_NAME}@${version})`);
  process.exit(1);
}

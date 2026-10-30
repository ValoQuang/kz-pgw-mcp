import "./helpers.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";

import { dist } from "./helpers.mjs";

const { parseEnvFile, renderEnvFile, get, isSecret } = await import(dist("core/env.js"));

test("parseEnvFile: comments, quotes, blank lines, = in values", () => {
  const v = parseEnvFile(`# c\n\nA=1\nB="two words"\nC='x#y'\nD=a=b\n=bad\nE=\n`);
  assert.deepEqual(v, { A: "1", B: "two words", C: "x#y", D: "a=b", E: "" });
});

test("renderEnvFile round-trips through parseEnvFile and masks secrets", () => {
  const v = { KZ_ROLE: "dev", KZ_USERNAME: "qa", KZ_PASSWORD: "p w#1", KZ_TOTP_SECRET_TPG1: "ABC" };
  const text = renderEnvFile(v, "h");
  const back = parseEnvFile(text);
  for (const [k, val] of Object.entries(v)) assert.equal(back[k], val, k);

  const masked = renderEnvFile(v, "h", true);
  assert.match(masked, /KZ_PASSWORD=\*\*\*/);
  assert.match(masked, /KZ_TOTP_SECRET_TPG1=\*\*\*/);
  assert.doesNotMatch(masked, /p w#1/);
});

test("get applies defaults; emptyIsValue keeps \"\"", () => {
  delete process.env.KZ_STAGING_DOMAIN;
  assert.equal(get("KZ_STAGING_DOMAIN"), "trykz.dev");
  process.env.PG_MCP_VPN_APP = "";
  assert.equal(get("PG_MCP_VPN_APP"), "");
  delete process.env.PG_MCP_VPN_APP;
  assert.equal(get("PG_MCP_VPN_APP"), "NordLayer");
});

test("isSecret covers passwords and per-group TOTP keys", () => {
  assert.ok(isSecret("KZ_PASSWORD"));
  assert.ok(isSecret("KZ_TOTP_SECRET_TTG1"));
  assert.ok(!isSecret("KZ_USERNAME"));
});

import "./helpers.mjs";

import assert from "node:assert/strict";
import { test } from "node:test";

import { dist } from "./helpers.mjs";

const { totpCode, totpSecondsLeft } = await import(dist("bo/totp.js"));

// RFC 6238 appendix B, SHA1 seed "12345678901234567890". 8-digit values, last 6 digits here.
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("totpCode matches RFC 6238 vectors", () => {
  assert.equal(totpCode(SEED, 59_000), "287082");
  assert.equal(totpCode(SEED, 1_111_111_109_000), "081804");
  assert.equal(totpCode(SEED, 1_234_567_890_000), "005924");
  assert.equal(totpCode(SEED, 2_000_000_000_000), "279037");
});

test("totpCode ignores case, spaces and padding in the secret", () => {
  assert.equal(totpCode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq==", 59_000), "287082");
});

test("totpSecondsLeft counts down within the 30 s window", () => {
  assert.equal(totpSecondsLeft(0), 30);
  assert.equal(totpSecondsLeft(29_000), 1);
  assert.equal(totpSecondsLeft(30_000), 30);
});

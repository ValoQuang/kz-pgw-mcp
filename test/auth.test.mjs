import "./helpers.mjs";

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { dist, mockFetch, token } from "./helpers.mjs";

process.env.KZ_USERNAME = "qa.bot";
process.env.KZ_PASSWORD = "pw";

const auth = await import(dist("bo/auth.js"));
const { totpCode } = await import(dist("bo/totp.js"));

const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

beforeEach(() => {
  for (const g of ["tpg1", "ttg1"]) auth.logout(g);
  delete process.env.KZ_TOTP_SECRET_TPG1;
});

/** kz-api /oauth stub. totpEnabled per call; tokens named after the grant. */
function oauthApi({ totpEnabled, pre = {}, real = {}, refreshed = {}, refreshStatus = 200 } = {}) {
  return mockFetch((req) => {
    if (req.url.endsWith("/oauth/totp")) return [200, { result: { totpEnabled } }];
    const grant = req.body.grant_type;
    if (grant === "password") return [200, token("pre", pre)];
    if (grant === "totp") return [200, token("real", real)];
    if (grant === "refresh_token") return [refreshStatus, refreshStatus === 200 ? token("refreshed", refreshed) : { message: "bad refresh" }];
    return [400, { message: `unexpected grant ${grant}` }];
  });
}

test("login without TOTP: one session, bearer returns the token", async () => {
  const calls = oauthApi({ totpEnabled: false });
  const r = await auth.login("tpg1");
  assert.equal(r.totpRequired, false);
  assert.equal(await auth.bearer("tpg1"), "access-pre");
  assert.equal(calls[0].url, "https://api.tpg1.trykz.dev/oauth/totp");
  assert.deepEqual(calls[1].body, {
    client_id: "qa.bot", client_secret: "pw", entity_type: "person", grant_type: "password",
  });
});

test("login with TOTP and no secret: bearer refuses until the code is submitted", async () => {
  oauthApi({ totpEnabled: true });
  const r = await auth.login("tpg1");
  assert.deepEqual(r, { totpRequired: true, autoTotp: false });
  await assert.rejects(auth.bearer("tpg1"), /Not logged in to tpg1/);

  await auth.submitTotp("tpg1", "123456");
  assert.equal(await auth.bearer("tpg1"), "access-real");
  assert.equal(auth.status()[0].totpDone, true);
});

test("login with KZ_TOTP_SECRET_<GROUP>: TOTP step runs by itself with the right code", async () => {
  process.env.KZ_TOTP_SECRET_TPG1 = SEED;
  const calls = oauthApi({ totpEnabled: true });
  const r = await auth.login("tpg1");
  assert.equal(r.autoTotp, true);
  const sent = calls.find((c) => c.body?.grant_type === "totp").body.totp;
  // Code may roll over between send and check; accept this window or the previous one.
  assert.ok([totpCode(SEED), totpCode(SEED, Date.now() - 30_000)].includes(sent), `sent ${sent}`);
  assert.equal(await auth.bearer("tpg1"), "access-real");
});

test("expired access token is refreshed once and cached", async () => {
  const calls = oauthApi({ totpEnabled: false, pre: { expiresIn: 10 } });
  await auth.login("tpg1");
  assert.equal(await auth.bearer("tpg1"), "access-refreshed");
  assert.equal(await auth.bearer("tpg1"), "access-refreshed");
  assert.equal(calls.filter((c) => c.body?.grant_type === "refresh_token").length, 1);
  assert.equal(calls.at(-1).body.refresh_token, "refresh-pre");
});

test("failed refresh drops the session and says to log in again", async () => {
  oauthApi({ totpEnabled: false, pre: { expiresIn: 10 }, refreshStatus: 401 });
  await auth.login("tpg1");
  await assert.rejects(auth.bearer("tpg1"), /Refresh failed for tpg1: .*401.*Re-run bo_login/);
  assert.equal(auth.status().length, 0);
});

test("refresh token expired too: session dropped, no API call", async () => {
  const calls = oauthApi({ totpEnabled: false, pre: { expiresIn: 10, refreshIn: 30 } });
  await auth.login("tpg1");
  const before = calls.length;
  await assert.rejects(auth.bearer("tpg1"), /Session for tpg1 expired/);
  assert.equal(calls.length, before);
  assert.equal(auth.status().length, 0);
});

test("sessions are per group", async () => {
  oauthApi({ totpEnabled: false });
  await auth.login("tpg1");
  await assert.rejects(auth.bearer("ttg1"), /Not logged in to ttg1/);
});

test("invalid group never reaches the network", async () => {
  const calls = oauthApi({ totpEnabled: false });
  await assert.rejects(auth.login("evil.com/x"), /Invalid group/);
  assert.equal(calls.length, 0);
});

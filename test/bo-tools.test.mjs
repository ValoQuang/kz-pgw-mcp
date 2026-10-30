// bo_* tools through a real MCP client, in-process. Project role (no DB), writes enabled:
// checks what reaches the network and what never does.
import "./helpers.mjs";

import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

import { dist, mockFetch, token } from "./helpers.mjs";

process.env.KZ_ROLE = "project";
process.env.KZ_USERNAME = "qa.bot";
process.env.KZ_PASSWORD = "pw";
process.env.KZ_PGW_ALLOW_WRITES = "true";

const { buildServer } = await import(dist("server.js"));
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let client;
let calls;
const UUID = "00000000-0000-0000-0000-000000000001";

before(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});

beforeEach(async () => {
  calls = mockFetch((req) => {
    if (req.url.endsWith("/oauth/totp")) return [200, { result: { totpEnabled: false } }];
    if (req.url.includes("/oauth/access_token")) return [200, token("t")];
    return [200, { result: { ok: true, path: new URL(req.url).pathname } }];
  });
  await client.callTool({ name: "bo_logout", arguments: { group: "tpg1" } });
});

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, text: r.content?.[0]?.text ?? "" };
};
const apiCalls = () => calls.filter((c) => !c.url.includes("/oauth/"));
const login = () => call("bo_login", { group: "tpg1" });

test("bo_api GET is sent with the session bearer", async () => {
  await login();
  const r = await call("bo_api", { group: "tpg1", path: "/account/funding/tx?memberId=x" });
  assert.equal(r.isError, undefined, r.text);
  const [c] = apiCalls();
  assert.equal(c.url, "https://api.tpg1.trykz.dev/account/funding/tx?memberId=x");
  assert.equal(c.headers.Authorization, "Bearer access-t");
});

test("bo_api before login: error, nothing sent", async () => {
  const r = await call("bo_api", { group: "tpg1", path: "/account/funding/tx" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Not logged in to tpg1/);
  assert.equal(calls.length, 0);
});

for (const [method, path] of [
  ["POST", "/account/funding/tx/adjust"],
  ["POST", "/account/funding/tx/deposit/../adjust"],
  ["POST", "/account/funding/tx/x/%2e%2e/adjust"],
  ["PUT", "/account/funding/tx/deposit"],
  ["DELETE", "/account/funding/tx/withdraw"],
  ["PATCH", "/platform/settings"],
]) {
  test(`bo_api ${method} ${path} is refused before any request`, async () => {
    await login();
    const r = await call("bo_api", { group: "tpg1", method, path });
    assert.equal(r.isError, true);
    assert.match(r.text, /not allowed/);
    assert.equal(apiCalls().length, 0);
  });
}

test("bo_api path leaving the group host is refused", async () => {
  await login();
  const r = await call("bo_api", { group: "tpg1", path: "//evil.com/x" });
  assert.equal(r.isError, true);
  assert.match(r.text, /stay on the group API host/);
  assert.equal(apiCalls().length, 0);
});

test("bo_api POST deposit (allow-listed) reaches kz-api with the body", async () => {
  await login();
  const body = { memberId: UUID, amount: 300 };
  const r = await call("bo_api", { group: "tpg1", method: "POST", path: "/account/funding/tx/deposit/", body });
  assert.equal(r.isError, undefined, r.text);
  const [c] = apiCalls();
  assert.equal(c.method, "POST");
  assert.equal(c.url, "https://api.tpg1.trykz.dev/account/funding/tx/deposit");
  assert.deepEqual(c.body, body);
});

test("writes off: bo_api POST deposit refused, nothing sent", async () => {
  await login();
  process.env.KZ_PGW_ALLOW_WRITES = "false";
  try {
    const r = await call("bo_api", { group: "tpg1", method: "POST", path: "/account/funding/tx/deposit", body: {} });
    assert.equal(r.isError, true);
    assert.match(r.text, /KZ_PGW_ALLOW_WRITES/);
    assert.equal(apiCalls().length, 0);
  } finally {
    process.env.KZ_PGW_ALLOW_WRITES = "true";
  }
});

test("kz-api error status comes back as a tool error with the API message", async () => {
  await login();
  calls = mockFetch(() => [403, { message: "missing account:deposit-creator" }]);
  const r = await call("bo_api", { group: "tpg1", path: "/account/funding/tx" });
  assert.equal(r.isError, true);
  assert.match(r.text, /403.*deposit-creator/);
});

test("project role hides pg_* tools", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("bo_api"));
  assert.ok(!names.some((n) => n.startsWith("pg_")), names.join(", "));
});

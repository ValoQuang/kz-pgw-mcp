import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GROUP_RE, bo as cfg, pg as pgCfg } from "../config.js";
import { queryRows } from "../pg/db.js";
import { formatPgError } from "../pg/errors.js";
import { fail, ok, type ToolResult } from "../result.js";
import { apiCall } from "./api.js";
import { login, logout, status, submitTotp } from "./auth.js";

const group = z
  .string()
  .regex(new RegExp(GROUP_RE.source, "i"), "group looks like tpg1, ttg1, tth1, tco")
  .describe("Staging group, e.g. tpg1 → https://api.tpg1.trykz.dev");

const uuid = z.string().uuid();

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const WRITE_GATE =
  "Write tools are disabled. Set KZ_PGW_ALLOW_WRITES=true (in ~/.config/kz-pgw/.env or via `kz-pgw-mcp init`) and restart the MCP server.";

function writesAllowed(): ToolResult | null {
  return cfg.allowWrites() ? null : fail(WRITE_GATE);
}

interface MemberRow {
  memberId: string;
  apiIdentifier: string;
  balance: string;
  fundingProfileId: string;
  profileType: string;
  bankKey: string;
  accNo: string;
  isPrimary: boolean;
}

const FIND_SQL = `
SELECT m.id            AS "memberId",
       m."apiIdentifier",
       w.balance::text AS balance,
       fp.id           AS "fundingProfileId",
       fp.type         AS "profileType",
       fp.key          AS "bankKey",
       fp."accNo",
       fp."isPrimary"
FROM wallet w
JOIN member m ON m.id = w."memberId" AND m."deletedAt" IS NULL
JOIN "fundingProfile" fp ON fp."memberId" = m.id AND fp."deletedAt" IS NULL
WHERE w.type = 'default'
  AND w."deletedAt" IS NULL
  AND w.balance > $1
  AND ($2::text IS NULL OR fp.type = $2)
ORDER BY w.balance DESC, fp."isPrimary" DESC
LIMIT $3`;

export function registerBoTools(server: McpServer): void {
  const writes = cfg.allowWrites();
  const gateNote = writes ? "" : "\n\nNOTE: currently DISABLED (KZ_PGW_ALLOW_WRITES is not true). Calling it returns an error.";

  // ---- auth ----

  server.registerTool(
    "bo_login",
    {
      title: "Login to KZ backoffice (step 1)",
      description: `Start login for one staging group using the configured KZ_USERNAME / KZ_PASSWORD.
Calls /oauth/totp then /oauth/access_token (grant_type=password).
If KZ_TOTP_SECRET_<GROUP> is configured, the TOTP step is done automatically (autoTotp=true).
Otherwise, if totpRequired is true, ask the user for the 6-digit code and call bo_submit_totp.
Returns: { group, totpRequired, autoTotp, expiresAt? }`,
      inputSchema: { group },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ group: g }) => {
      try {
        const r = await login(g.toLowerCase());
        return ok({ group: g.toLowerCase(), ...r, next: r.totpRequired ? "Ask user for TOTP code, then bo_submit_totp" : "Logged in" });
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "bo_submit_totp",
    {
      title: "Submit TOTP code (step 2)",
      description: `Exchange the user's 6-digit TOTP code for a real access token (grant_type=totp).
Call only after bo_login returned totpRequired=true.
Returns: { group, loggedIn, expiresAt }`,
      inputSchema: {
        group,
        totp: z.string().regex(/^\d{6}$/, "6 digits").describe("6-digit code from the authenticator app"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ group: g, totp }) => {
      try {
        const s = await submitTotp(g.toLowerCase(), totp);
        return ok({ group: g.toLowerCase(), loggedIn: true, expiresAt: s.expiresAt });
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "bo_whoami",
    {
      title: "Show active sessions",
      description: "Lists groups with a cached token and how long each has left. Returns: { sessions: [{ group, totpDone, expiresAt, expiresInSec }], writesEnabled }",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ok({ sessions: status(), writesEnabled: cfg.allowWrites() }),
  );

  server.registerTool(
    "bo_logout",
    {
      title: "Drop a cached session",
      description: "Forgets the cached token for a group. Returns: { group, removed }",
      inputSchema: { group },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ group: g }) => ok({ group: g.toLowerCase(), removed: logout(g.toLowerCase()) }),
  );

  // ---- funding ----

  server.registerTool(
    "bo_find_member",
    {
      title: "Find test members by balance",
      description: `Reads the group DB (database = kz-{group} on the staging cluster) and returns members with wallet.balance > minBalance
and at least one non-deleted fundingProfile. One row per (member, profile).
Use this to pick a memberId + fundingProfileId for bo_create_deposit.
Returns: { count, members: [{ memberId, apiIdentifier, balance, fundingProfileId, profileType, bankKey, accNo, isPrimary }] }`,
      inputSchema: {
        group,
        minBalance: z.number().min(0).default(1000).describe("Wallet balance must exceed this"),
        profileType: z.enum(["bank", "e-wallet"]).optional().describe("Filter by fundingProfile.type"),
        limit: z.number().int().min(1).max(50).default(15),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ group: g, minBalance, profileType, limit }) => {
      try {
        const db = pgCfg.databaseForGroup(g.toLowerCase());
        const rows = await queryRows<MemberRow>(FIND_SQL, [minBalance, profileType ?? null, limit], db);
        return ok({ database: db, count: rows.length, members: rows });
      } catch (e) {
        return fail(formatPgError(e));
      }
    },
  );

  server.registerTool(
    "bo_create_deposit",
    {
      title: "Create a deposit order (backoffice)",
      description: `POST /account/funding/tx/deposit on the group API. Creates a real deposit fundingTx on staging.
Confirm memberId, fundingProfileId, amount and method with the user before calling.
Args:
  - method: exact provider/method string, e.g. "cpay-2/bank-transfer"
  - date: unix seconds; defaults to now
Returns: { request, response } — response contains the created tx.${gateNote}`,
      inputSchema: {
        group,
        memberId: uuid.describe("member.id"),
        fundingProfileId: uuid.describe("fundingProfile.id belonging to that member"),
        amount: z.number().positive().describe("Deposit amount in group currency"),
        method: z.string().min(3).describe('e.g. "cpay-2/bank-transfer"'),
        providerRef: z.string().optional().describe("Provider reference, if any"),
        remark: z.string().optional(),
        memo: z.string().optional(),
        date: z.number().int().optional().describe("Unix seconds. Default: now"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ group: g, memberId, fundingProfileId, amount, method, providerRef, remark, memo, date }) => {
      const gate = writesAllowed();
      if (gate) return gate;
      try {
        const body = {
          memberId,
          amount,
          providerRef: providerRef ?? "",
          remark: remark ?? "",
          date: date ?? Math.floor(Date.now() / 1000),
          fundingProfileId,
          memo: memo ?? "",
          method,
        };
        const res = await apiCall(g.toLowerCase(), "POST", "/account/funding/tx/deposit", body);
        return ok({ request: body, response: res });
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "bo_create_withdraw",
    {
      title: "Create a withdraw order (backoffice)",
      description: `POST /account/funding/tx/withdraw on the group API. Creates a real withdraw fundingTx on staging
(may land in pending-audit). Needs privilege account:withdrawal-creator.
Confirm memberId, fundingProfileId and amount with the user before calling.
Args:
  - method: optional FundingMethodKey, e.g. "cpay-2/bank-transfer". Omit to let the API pick.
Returns: { request, response } — response.result.model is the created tx.${gateNote}`,
      inputSchema: {
        group,
        memberId: uuid.describe("member.id"),
        fundingProfileId: uuid.describe("fundingProfile.id belonging to that member (payout destination)"),
        amount: z.number().positive().describe("Withdraw amount in group currency"),
        method: z.string().min(3).optional().describe('e.g. "cpay-2/bank-transfer"'),
        remark: z.string().optional(),
        memo: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ group: g, memberId, fundingProfileId, amount, method, remark, memo }) => {
      const gate = writesAllowed();
      if (gate) return gate;
      try {
        const body: Record<string, unknown> = { memberId, amount, fundingProfileId, remark: remark ?? "", memo: memo ?? "" };
        if (method) body.method = method;
        const res = await apiCall(g.toLowerCase(), "POST", "/account/funding/tx/withdraw", body);
        return ok({ request: body, response: res });
      } catch (e) {
        return fail(msg(e));
      }
    },
  );

  server.registerTool(
    "bo_api",
    {
      title: "Raw authenticated API call",
      description: `Escape hatch: call any kz-api path on the group with the cached bearer token.
Use for endpoints not yet wrapped (approve, lookups). GET always allowed.
Non-GET methods need KZ_PGW_ALLOW_WRITES=true${writes ? " (currently enabled)" : " (currently DISABLED)"}. Confirm with the user before non-GET calls.
Returns: raw response.`,
      inputSchema: {
        group,
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string().startsWith("/").describe('e.g. "/account/funding/tx?memberId=..."'),
        body: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ group: g, method, path, body }) => {
      if (method !== "GET") {
        const gate = writesAllowed();
        if (gate) return gate;
      }
      try {
        return ok(await apiCall(g.toLowerCase(), method, path, body));
      } catch (e) {
        return fail(msg(e));
      }
    },
  );
}

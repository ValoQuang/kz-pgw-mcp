/** Backoffice MCP tools: login/session, member lookup, methods/orders lists, deposit/withdraw, raw API. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { bo as cfg, pg as pgCfg, role } from "../core/config.js";
import { CLI, GROUP_HINT, GROUP_RE, HINTS, ORDER_LIMITS, TOOLS } from "../core/constants.js";
import type { EnvKey } from "../core/env.js";
import { CONFIG_FILE } from "../core/paths.js";
import { fail, ok, safely, type ToolResult } from "../core/result.js";
import { queryRows } from "../pg/db.js";
import { formatPgError } from "../pg/errors.js";
import { apiCall } from "./api.js";
import { login, logout, status, submitTotp } from "./auth.js";
import { BO_PATH, normalizePath, WRITE_PATHS, writeTarget, type WriteKind } from "./paths.js";
import { findMembersViaApi, listMethods, listOrders, matchProviders, summarize } from "./reads.js";

const WRITE_KEY: EnvKey = "KZ_PGW_ALLOW_WRITES";

/** Normalised to lower case before validation. */
const group = z
  .string()
  .trim()
  .toLowerCase()
  .regex(GROUP_RE, `group looks like ${GROUP_HINT}`)
  .describe("Staging group, e.g. tpg1 → https://api.tpg1.trykz.dev");

const uuid = z.string().uuid();
const memberId = uuid.describe("member.id");
const method = z.string().min(3);
const optionalText = z.string().optional();

/** Write tools return this error unless writes are enabled. */
function writeGate(): ToolResult | null {
  return cfg.allowWrites()
    ? null
    : fail(`Write tools are disabled. Set ${WRITE_KEY}=true (in ${CONFIG_FILE} or via \`${CLI.init}\`) and restart the MCP server.`);
}

const nowS = (): number => Math.floor(Date.now() / 1000);

/**
 * kz-api privileges for each write (routes/api/account/funding/tx/index.ts).
 * platform:super-admin passes every check (app/auth/access.ts verifyPrivilege).
 */
const PRIV: Record<WriteKind, string> = { deposit: "deposit-creator", withdraw: "withdrawal-creator" };
const SUPER_ADMIN = "platform:super-admin";

/** Privileges of the configured staff login, read from the group DB. Same source kz-api uses: entityHasPrivilege. */
const ACCESS_SQL = `
SELECT p.domain || ':' || p.name AS privilege
FROM credential c
JOIN entity e ON e.id = c."entityId" AND e."deletedAt" IS NULL
JOIN "entityHasPrivilege" ehp ON ehp."entityId" = e.id
JOIN privilege p ON p.id = ehp."privilegeId"
WHERE c."accessKey" = $1
  AND c.type = 'password'
  AND c."deletedAt" IS NULL
  AND ((p.domain = 'account' AND p.name = ANY($2)) OR (p.domain || ':' || p.name = $3))`;

interface Access {
  group: string;
  username: string;
  database: string | null;
  deposit: boolean | null;
  withdraw: boolean | null;
  privileges: string[];
  note?: string;
}

async function checkAccess(group: string): Promise<Access> {
  const { username } = cfg.credentials();
  if (role.isProject()) {
    return {
      group, username, database: null, deposit: null, withdraw: null, privileges: [],
      note: `Project role: no DB, so privileges are not pre-checked. kz-api answers 403 if ${username} lacks account:${PRIV.deposit} / account:${PRIV.withdraw}.`,
    };
  }
  const database = pgCfg.databaseForGroup(group);
  const rows = await queryRows<{ privilege: string }>(ACCESS_SQL, [username, Object.values(PRIV), SUPER_ADMIN], database);
  const privileges = rows.map((r) => r.privilege);
  const has = (k: WriteKind) => privileges.includes(SUPER_ADMIN) || privileges.includes(`account:${PRIV[k]}`);
  return { group, username, database, deposit: has("deposit"), withdraw: has("withdraw"), privileges };
}

/** Write tools stop here unless the staff login holds the privilege on this group. Nothing is sent to the API. */
async function privilegeGate(group: string, kind: WriteKind): Promise<ToolResult | null> {
  // Project role has no DB: kz-api's own privilege check (403) is the gate.
  if (role.isProject()) return null;
  const a = await checkAccess(group);
  return a[kind]
    ? null
    : fail(`Stopped: ${a.username} has no account:${PRIV[kind]} on ${group} (checked ${a.database}). Nothing was sent. Ask a ${group} admin to grant it.`);
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

const FIND_MEMBER_SQL = `
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
  const gateNote = writes ? "" : `\n\nNOTE: currently DISABLED (${WRITE_KEY} is not true). Calling it returns an error.`;

  // ---- auth ----

  server.registerTool(
    TOOLS.boLogin,
    {
      title: "Login to KZ backoffice (step 1)",
      description: `Start login for one staging group using the configured KZ_USERNAME / KZ_PASSWORD.
Calls /oauth/totp then /oauth/access_token (grant_type=password).
If KZ_TOTP_SECRET_<GROUP> is configured, the TOTP step is done automatically (autoTotp=true).
Otherwise, if totpRequired is true, ask the user for the 6-digit code and call ${TOOLS.boSubmitTotp}.
Returns: { group, totpRequired, autoTotp, expiresAt? }`,
      inputSchema: { group },
      annotations: HINTS.auth,
    },
    safely(async ({ group: g }) => {
      const r = await login(g);
      return ok({ group: g, ...r, next: r.totpRequired ? `Ask user for TOTP code, then ${TOOLS.boSubmitTotp}` : "Logged in" });
    }),
  );

  server.registerTool(
    TOOLS.boSubmitTotp,
    {
      title: "Submit TOTP code (step 2)",
      description: `Exchange the user's 6-digit TOTP code for a real access token (grant_type=totp).
Call only after ${TOOLS.boLogin} returned totpRequired=true.
Returns: { group, loggedIn, expiresAt }`,
      inputSchema: {
        group,
        totp: z.string().regex(/^\d{6}$/, "6 digits").describe("6-digit code from the authenticator app"),
      },
      annotations: HINTS.auth,
    },
    safely(async ({ group: g, totp }) => ok({ group: g, loggedIn: true, expiresAt: (await submitTotp(g, totp)).expiresAt })),
  );

  server.registerTool(
    TOOLS.boWhoami,
    {
      title: "Show active sessions",
      description: "Lists groups with a cached token and how long each has left. Returns: { sessions: [{ group, totpDone, expiresAt, expiresInSec }], writesEnabled }",
      inputSchema: {},
      annotations: HINTS.read,
    },
    async () => ok({ sessions: status(), writesEnabled: cfg.allowWrites() }),
  );

  server.registerTool(
    TOOLS.boCheckAccess,
    {
      title: "Check write privileges",
      description: `dev role: reads the group DB (kz-{group}). project role: no DB, returns nulls + a note (kz-api enforces with 403). Reports whether the configured staff login (KZ_USERNAME) may create deposits / withdraws there.
Needs account:${PRIV.deposit} / account:${PRIV.withdraw}, or ${SUPER_ADMIN}. No login needed.
Call before offering a write. ${TOOLS.boCreateDeposit} / ${TOOLS.boCreateWithdraw} run the same check and stop if it fails.
Returns: { group, username, database, deposit, withdraw, privileges }`,
      inputSchema: { group },
      annotations: HINTS.readRemote,
    },
    safely(async ({ group: g }) => ok(await checkAccess(g)), formatPgError),
  );

  server.registerTool(
    TOOLS.boLogout,
    {
      title: "Drop a cached session",
      description: "Forgets the cached token for a group. Returns: { group, removed }",
      inputSchema: { group },
      annotations: HINTS.session,
    },
    async ({ group: g }) => ok({ group: g, removed: logout(g) }),
  );

  // ---- funding ----

  server.registerTool(
    TOOLS.boFindMember,
    {
      title: "Find test members by balance",
      description: `Returns members with wallet.balance > minBalance and at least one non-deleted fundingProfile. One row per (member, profile).
dev role: reads the group DB (kz-{group}). project role: backoffice API (needs bo_login; scans up to ${ORDER_LIMITS.memberScan} members).
Use this to pick a memberId + fundingProfileId for ${TOOLS.boCreateDeposit}.
Returns: { count, members: [{ memberId, apiIdentifier, balance, fundingProfileId, profileType, bankKey, accNo, isPrimary }] }`,
      inputSchema: {
        group,
        minBalance: z.number().min(0).default(1000).describe("Wallet balance must exceed this"),
        profileType: z.enum(["bank", "e-wallet"]).optional().describe("Filter by fundingProfile.type"),
        limit: z.number().int().min(1).max(50).default(15),
      },
      annotations: HINTS.readRemote,
    },
    safely(async ({ group: g, minBalance, profileType, limit }) => {
      if (role.isProject()) {
        const r = await findMembersViaApi(g, { minBalance, profileType, limit });
        return ok({ source: "backoffice api", count: r.members.length, scannedMembers: r.scanned, members: r.members });
      }
      const db = pgCfg.databaseForGroup(g);
      const rows = await queryRows<MemberRow>(FIND_MEMBER_SQL, [minBalance, profileType ?? null, limit], db);
      return ok({ database: db, count: rows.length, members: rows });
    }, formatPgError),
  );

  server.registerTool(
    TOOLS.boListMethods,
    {
      title: "List funding methods / providers",
      description: `GET /account/funding/method/list on the group. Backoffice API, both roles. Needs ${TOOLS.boLogin}.
Use to resolve a provider name to its providerKey and to pick a method key ("<providerKey>/<channel>") for ${TOOLS.boCreateDeposit}.
Args:
  - provider: optional key or name, e.g. "cpay-2", "Cpay", "toppay". Omit for all.
  - type: optional "deposit" | "withdraw".
Returns: { providers: [providerKey], count, methods: [{ key, providerKey, type, name, internalName, status, returnType, min, max, currency }] }`,
      inputSchema: {
        group,
        provider: z.string().min(2).optional(),
        type: z.enum(["deposit", "withdraw"]).optional(),
      },
      annotations: HINTS.readRemote,
    },
    safely(async ({ group: g, provider, type }) => {
      const all = await listMethods(g);
      const scoped = provider ? matchProviders(all, provider).methods : all;
      const methods = type ? scoped.filter((m) => m.type === type) : scoped;
      return ok({ group: g, providers: [...new Set(methods.map((m) => m.providerKey))].sort(), count: methods.length, methods });
    }),
  );

  server.registerTool(
    TOOLS.boListOrders,
    {
      title: "List deposit / withdraw orders",
      description: `GET /account/funding/tx/list on the group. Backoffice API, both roles. Needs ${TOOLS.boLogin}.
Give at least one of provider, orderRef, memberId.
  - By provider: provider + since required. provider can be a providerKey ("cpay-2") or a name ("Cpay"); it is resolved through the funding method list. Ambiguous names return every match.
  - By orderRef: exact order ref, e.g. "TPG1XFW123"; comma list for several. since optional.
  - By memberId: that member's orders, newest first when since is omitted.
Args:
  - since: ISO date/time (UTC), e.g. "2026-10-20" or "2026-10-20T07:00:00Z". until defaults to now. Omitted → no time filter.
  - type: "deposit" | "withdraw" | "all" (default all).
  - status: optional filter, comma list, e.g. "completed,error".
Cannot search by providerRef (the provider's own tx id): the API has no filter for it. Use provider + window and read providerRef in the rows.
Each order: creatorId null = created by the player in MP; set = created by staff in BO. callbackToDoneSec = seconds from provider callback to completed/cancelled.
Returns: { providers, window, total, returned, summary: { type: { status: count } }, orders: [...] }`,
      inputSchema: {
        group,
        provider: z.string().min(2).optional().describe('providerKey or name, e.g. "cpay-2" or "Cpay"'),
        orderRef: z.string().trim().min(3).optional().describe('fundingTx.orderRef, e.g. "TPG1XFW123". Comma list allowed'),
        memberId: memberId.optional(),
        since: z.string().min(8).optional().describe("ISO date/time, UTC. Required with provider"),
        until: z.string().min(8).optional(),
        type: z.enum(["deposit", "withdraw", "all"]).default("all"),
        status: z.string().optional(),
        limit: z.number().int().min(1).max(ORDER_LIMITS.max).default(ORDER_LIMITS.default),
      },
      annotations: HINTS.readRemote,
    },
    safely(async ({ group: g, provider, orderRef, memberId: member, since, until, type, status, limit }) => {
      if (!provider && !orderRef && !member) return fail("Give at least one of provider, orderRef, memberId.");
      if (provider && !since) return fail("since is required with provider, e.g. since: \"2026-10-20\".");
      if (until && !since) return fail("until needs since.");
      for (const d of [since, until]) if (d && Number.isNaN(Date.parse(d))) return fail(`Not a date: "${d}". Use ISO, e.g. 2026-10-20 or 2026-10-20T07:00:00Z.`);
      let keys: string[] | undefined;
      let methods: Awaited<ReturnType<typeof listMethods>> = [];
      if (provider) {
        ({ keys, methods } = matchProviders(await listMethods(g), provider));
        if (!keys.length) {
          const known = [...new Set((await listMethods(g)).map((m) => m.providerKey))].sort();
          return fail(`No provider matches "${provider}" on ${g}. Known providerKeys: ${known.join(", ") || "(none)"}`);
        }
      }
      const types = type === "all" ? ["deposit", "withdraw"] : [type];
      const sinceIso = since ? new Date(since).toISOString() : undefined;
      const untilIso = since ? (until ? new Date(until).toISOString() : new Date().toISOString()) : undefined;
      const { orders, total } = await listOrders(g, {
        providerKeys: keys, types, since: sinceIso, until: untilIso, status, orderRef, memberId: member, limit,
      });
      return ok({
        group: g,
        providers: keys ?? null,
        methods: methods.map((m) => `${m.key} (${m.type}, ${m.status})`),
        window: sinceIso ? { since: sinceIso, until: untilIso } : null,
        total,
        returned: orders.length,
        truncated: total !== null && total > orders.length,
        summary: summarize(orders),
        orders,
      });
    }),
  );

  server.registerTool(
    TOOLS.boCreateDeposit,
    {
      title: "Create a deposit order (backoffice)",
      description: `POST ${BO_PATH.deposit} on the group API. Creates a real deposit fundingTx on staging.
Confirm memberId, fundingProfileId, amount and method with the user before calling.
Stops without calling the API unless the staff login has account:${PRIV.deposit} on the group (see ${TOOLS.boCheckAccess}).
Args:
  - method: exact provider/method string, e.g. "cpay-2/bank-transfer"
  - date: unix seconds; defaults to now
Returns: { request, response } — response contains the created tx.${gateNote}`,
      inputSchema: {
        group,
        memberId,
        fundingProfileId: uuid.describe("fundingProfile.id belonging to that member"),
        amount: z.number().positive().describe("Deposit amount in group currency"),
        method: method.describe('e.g. "cpay-2/bank-transfer"'),
        providerRef: z.string().optional().describe("Provider reference, if any"),
        remark: optionalText,
        memo: optionalText,
        date: z.number().int().optional().describe("Unix seconds. Default: now"),
      },
      annotations: HINTS.write,
    },
    safely(async ({ group: g, memberId, fundingProfileId, amount, method, providerRef, remark, memo, date }) => {
      const gate = writeGate() ?? (await privilegeGate(g, "deposit"));
      if (gate) return gate;
      const body = {
        memberId,
        amount,
        providerRef: providerRef ?? "",
        remark: remark ?? "",
        date: date ?? nowS(),
        fundingProfileId,
        memo: memo ?? "",
        method,
      };
      return ok({ request: body, response: await apiCall(g, "POST", BO_PATH.deposit, body) });
    }),
  );

  server.registerTool(
    TOOLS.boCreateWithdraw,
    {
      title: "Create a withdraw order (backoffice)",
      description: `POST ${BO_PATH.withdraw} on the group API. Creates a real withdraw fundingTx on staging
(may land in pending-audit). Stops without calling the API unless the staff login has account:${PRIV.withdraw} on the group (see ${TOOLS.boCheckAccess}).
Confirm memberId, fundingProfileId and amount with the user before calling.
Args:
  - method: optional FundingMethodKey, e.g. "cpay-2/bank-transfer". Omit to let the API pick.
Returns: { request, response } — response.result.model is the created tx.${gateNote}`,
      inputSchema: {
        group,
        memberId,
        fundingProfileId: uuid.describe("fundingProfile.id belonging to that member (payout destination)"),
        amount: z.number().positive().describe("Withdraw amount in group currency"),
        method: method.optional().describe('e.g. "cpay-2/bank-transfer"'),
        remark: optionalText,
        memo: optionalText,
      },
      annotations: HINTS.write,
    },
    safely(async ({ group: g, memberId, fundingProfileId, amount, method, remark, memo }) => {
      const gate = writeGate() ?? (await privilegeGate(g, "withdraw"));
      if (gate) return gate;
      const body: Record<string, unknown> = { memberId, amount, fundingProfileId, remark: remark ?? "", memo: memo ?? "" };
      if (method) body.method = method;
      return ok({ request: body, response: await apiCall(g, "POST", BO_PATH.withdraw, body) });
    }),
  );

  server.registerTool(
    TOOLS.boApi,
    {
      title: "Raw authenticated API call",
      description: `Escape hatch: call a kz-api path on the group with the cached bearer token.
GET: any path (lookups, lists, details).
Non-GET: only POST ${Object.keys(WRITE_PATHS).join(", ")}, with the same privilege check as ${TOOLS.boCreateDeposit} / ${TOOLS.boCreateWithdraw}. Everything else (adjust, approve, reject, privileges, settings) is refused: use the BO web app.
Non-GET also needs ${WRITE_KEY}=true${writes ? " (currently enabled)" : " (currently DISABLED)"}. Confirm with the user first.
Returns: raw response.`,
      inputSchema: {
        group,
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string().startsWith("/").describe('e.g. "/account/funding/tx?memberId=..."'),
        body: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: HINTS.raw,
    },
    safely(async ({ group: g, method, path, body }) => {
      const { pathname, search } = normalizePath(path);
      if (method !== "GET") {
        const gate = writeGate();
        if (gate) return gate;
        const kind = writeTarget(method, pathname);
        if (!kind) {
          return fail(`${method} ${pathname} is not allowed. Non-GET ${TOOLS.boApi} only allows POST ${Object.keys(WRITE_PATHS).join(", ")}. Use the BO web app for anything else.`);
        }
        const denied = await privilegeGate(g, kind);
        if (denied) return denied;
      }
      return ok(await apiCall(g, method, pathname + search, body));
    }),
  );
}

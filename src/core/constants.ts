/** Fixed names, commands, limits and timeouts. Change here, nowhere else. */

export const PKG = "@valoquang/kz-pgw-mcp";
export const SERVER_NAME = "kz-pgw-mcp";
/** Default MCP server name in Claude config → tools appear as mcp__kz-pgw__*. */
export const DEFAULT_MCP_NAME = "kz-pgw";

export const CLI = {
  init: `npx -y ${PKG} init`,
  doctor: `npx -y ${PKG} doctor`,
  install: `npx -y ${PKG} install`,
} as const;

export const TOOLS = {
  kzGuide: "kz_guide",
  kzSetRole: "kz_set_role",
  boLogin: "bo_login",
  boSubmitTotp: "bo_submit_totp",
  boWhoami: "bo_whoami",
  boCheckAccess: "bo_check_access",
  boLogout: "bo_logout",
  boFindMember: "bo_find_member",
  boListMethods: "bo_list_methods",
  boListOrders: "bo_list_orders",
  boCreateDeposit: "bo_create_deposit",
  boCreateWithdraw: "bo_create_withdraw",
  boApi: "bo_api",
  pgQuery: "pg_query",
  pgListTables: "pg_list_tables",
  pgDescribeTable: "pg_describe_table",
  pgListDatabases: "pg_list_databases",
} as const;

/** Tools only the dev role gets. Hidden for project. */
export const DEV_ONLY_TOOLS: readonly string[] = [
  TOOLS.pgQuery,
  TOOLS.pgListTables,
  TOOLS.pgDescribeTable,
  TOOLS.pgListDatabases,
];

/** Tools that work before a role is picked. */
export const NO_ROLE_TOOLS: readonly string[] = [TOOLS.kzGuide, TOOLS.kzSetRole];

/** bo_list_orders / bo_find_member caps. */
export const ORDER_LIMITS = { default: 100, max: 500, memberScan: 40 } as const;

/** Env var prefix for per-group TOTP secrets: KZ_TOTP_SECRET_TPG1. */
export const TOTP_SECRET_PREFIX = "KZ_TOTP_SECRET_";

/** Group code: tpg1, ttg1, tth1, tco. */
export const GROUP_RE = /^t[a-z]{2}\d?$/;
export const GROUP_HINT = "tpg1, ttg1, tth1, tco";

export const TIMEOUT_MS = {
  boApi: 30_000,
  boAuth: 20_000,
  pgConnect: 15_000,
  pgIdle: 60_000,
  sshReady: 15_000,
  sshKeepalive: 30_000,
  vpnNudgeCooldown: 60_000,
} as const;

export const ROWS = { default: 200, hardMax: 1000 } as const;

/** Max chars in one tool response before trimming. */
export const CHARACTER_LIMIT = 40_000;

/** Skill folders created by this package carry this marker file (content = version). */
export const SKILL_MARKER = ".kz-pgw-mcp";

/** MCP tool annotation presets. */
export const HINTS = {
  /** Reads only, safe to repeat. */
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  /** Reads a remote system. */
  readRemote: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  /** Local session state only. */
  session: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  /** Auth call to a remote system. */
  auth: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  /** Creates real data on a remote system (deposit, withdraw). */
  write: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  /** Arbitrary remote call. */
  raw: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
} as const;

/**
 * Role layer. Asked once, saved as KZ_ROLE.
 *   project → backoffice API only (no DB / SSH). pg_* hidden.
 *   dev     → backoffice + staging DB.
 * Until a role is picked, every tool except kz_guide / kz_set_role answers "ask the role first".
 */

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ROLES, role, type Role } from "./core/config.js";
import { CLI, DEV_ONLY_TOOLS, HINTS, NO_ROLE_TOOLS, TOOLS } from "./core/constants.js";
import { fail, ok, type ToolResult } from "./core/result.js";
import { saveConfigValue } from "./core/store.js";

export const ROLE_QUESTION =
  "One-time setup. Are you **project** (PA / QA / PM: backoffice login only) or **dev** (backoffice + staging DB)?";

const SKILLS = [
  { name: "kz-guide", say: "how do I use kz-pgw?", does: "This guide" },
  { name: "kz-create-orders", say: "make a 300 deposit on tpg1 via cpay-2", does: "Create test deposit / withdraw orders (asks ok? first)" },
  {
    name: "kz-verify-orders",
    say: "verify UAT for cpay-2 on tpg1 since 2026-10-20",
    does: "Show the 6 UAT cases (SOP OS-52). Map the client's orders to them, check the 3rd balance, give PASS / PENDING / FAIL",
  },
];

export function guide(r: Role | undefined = role.get()): string {
  const access =
    r === "project"
      ? "Role: **project**. Backoffice API only. No DB setup needed."
      : r === "dev"
        ? "Role: **dev**. Backoffice + read-only staging DB."
        : `Role: not set. ${ROLE_QUESTION}`;
  const lines = [
    "# kz-pgw: quick guide",
    "",
    access,
    "",
    "## Before you start",
    "1. Connect NordLayer → gateway `s5tech-VPS`.",
    "2. Say `login tpg1`. Reply with the 6-digit TOTP code if asked. A session lasts ~24 h.",
    "",
    "## Skills",
    "| Skill | Say | Does |",
    "|---|---|---|",
    ...SKILLS.map((s) => `| \`${s.name}\` | "${s.say}" | ${s.does} |`),
    "",
    "## Rules",
    "- Staging only (`*.trykz.dev`). Groups: tpg1, ttg1, tig1, tco, tpk1, tph1, tth1, tbd1, tgg, tpe.",
    "- Writes (deposit / withdraw) are off until `KZ_PGW_ALLOW_WRITES=true`, and always ask \"ok?\" first.",
    "- Adjust / approve / reject: use the BO web app.",
    "",
    "## Fixes",
    `- \`not configured\` → run \`${CLI.init}\`, restart Claude.`,
    "- Network error → connect NordLayer `s5tech-VPS`.",
    "- 401 → `login <group>` again.",
    `- Change role → say "set my kz role to dev" (or re-run \`${CLI.init}\`).`,
  ];
  return lines.join("\n");
}

/** Wrap registerTool so every handler checks the role first. Call before registering anything. */
export function gateByRole(server: McpServer): Map<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>();
  const orig = server.registerTool.bind(server) as (...a: unknown[]) => RegisteredTool;
  (server as unknown as { registerTool: (...a: unknown[]) => RegisteredTool }).registerTool = (name: unknown, config: unknown, cb: unknown) => {
    const handler = cb as (...a: unknown[]) => Promise<ToolResult> | ToolResult;
    const wrapped = async (...a: unknown[]): Promise<ToolResult> => {
      if (!NO_ROLE_TOOLS.includes(name as string) && !role.get()) {
        return fail(`Role not set. Ask the user once: "${ROLE_QUESTION}" Then call ${TOOLS.kzSetRole} and retry.`);
      }
      return handler(...a);
    };
    const t = orig(name, config, wrapped);
    registered.set(name as string, t);
    return t;
  };
  return registered;
}

/** Show / hide dev-only tools for the current role. Sends tools/list_changed when connected. */
export function applyRole(tools: Map<string, RegisteredTool>): void {
  const project = role.isProject();
  for (const name of DEV_ONLY_TOOLS) {
    const t = tools.get(name);
    if (!t) continue;
    if (project && t.enabled) t.disable();
    if (!project && !t.enabled) t.enable();
  }
}

export function registerRoleTools(server: McpServer, tools: Map<string, RegisteredTool>): void {
  server.registerTool(
    TOOLS.kzGuide,
    {
      title: "Show the kz-pgw quick guide",
      description: `Short how-to for this plugin: role, login, skills, rules, fixes. Show it to the user as-is.
Call on first use (right after ${TOOLS.kzSetRole}) and whenever the user asks how to use kz-pgw.
Returns: { role, roleSet, guide }`,
      inputSchema: {},
      annotations: HINTS.read,
    },
    async () => ok({ role: role.get() ?? null, roleSet: !!role.get(), guide: guide() }),
  );

  server.registerTool(
    TOOLS.kzSetRole,
    {
      title: "Save the user's role (one-time)",
      description: `Saves KZ_ROLE to the local config file. Ask the user first: "${ROLE_QUESTION}"
- project: backoffice API only. No DB questions. pg_* tools hidden.
- dev: backoffice + staging DB. If DB is not configured yet, tell the user to run \`${CLI.init}\`.
Returns: { role, savedTo, firstTime, guide } — show the guide when firstTime is true.`,
      inputSchema: { role: z.enum(ROLES).describe("project | dev") },
      annotations: HINTS.session,
    },
    async ({ role: r }) => {
      const firstTime = !role.get();
      const savedTo = saveConfigValue("KZ_ROLE", r);
      applyRole(tools);
      return ok({ role: r, savedTo, firstTime, guide: guide(r) });
    },
  );
}

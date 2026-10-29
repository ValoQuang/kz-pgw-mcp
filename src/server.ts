/** MCP server over stdio: registers kz_*, bo_*, pg_* tools (gated by role), syncs skills, logs status to stderr. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerBoTools } from "./bo/tools.js";
import { BO_KEYS, PG_KEYS, bo, loadedFrom, pg, role } from "./core/config.js";
import { CLI, SERVER_NAME } from "./core/constants.js";
import { missing } from "./core/env.js";
import { CONFIG_FILE } from "./core/paths.js";
import { VERSION } from "./core/version.js";
import { closePools, getTunnel } from "./pg/db.js";
import { registerPgTools } from "./pg/tools.js";
import { applyRole, gateByRole, registerRoleTools } from "./role.js";
import { syncSkillsReport } from "./skills/sync.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  const tools = gateByRole(server);
  registerRoleTools(server, tools);
  registerBoTools(server);
  registerPgTools(server);
  applyRole(tools);
  return server;
}

export async function serve(): Promise<void> {
  await buildServer().connect(new StdioServerTransport());

  // stdout is the MCP channel. Status goes to stderr only.
  const boMissing = missing(BO_KEYS);
  const pgMissing = missing(PG_KEYS);
  const r = role.get();
  const project = r === "project";
  const lines = [
    `${SERVER_NAME} ${VERSION} ready`,
    `  config: ${loadedFrom.length ? loadedFrom.join(", ") : "env only"}`,
    `  role: ${r ?? "not set (asked on first use)"}`,
    `  backoffice: ${boMissing.length ? `NOT configured (missing ${boMissing.join(", ")})` : `ok, writes ${bo.allowWrites() ? "ENABLED" : "disabled"}`}`,
    project
      ? "  staging db: not used (project role)"
      : `  staging db: ${pgMissing.length ? `NOT configured (missing ${pgMissing.join(", ")})` : `${pg.label()}${getTunnel() ? ` via ssh ${getTunnel()!.label}` : ""}, read-only`}`,
  ];
  if (boMissing.length || (!project && pgMissing.length)) lines.push(`  fix: ${CLI.init}  (writes ${CONFIG_FILE})`);
  lines.push(`  skills: ${syncSkillsReport().join("; ")}`);
  console.error(lines.join("\n"));

  const shutdown = (): void => void closePools().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

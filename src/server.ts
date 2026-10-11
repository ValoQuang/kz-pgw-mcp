import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerBoTools } from "./bo/tools.js";
import { BO_KEYS, CONFIG_FILE, INIT_CMD, PG_KEYS, bo, loadedFrom, missing, pg } from "./config.js";
import { closePools, getTunnel } from "./pg/db.js";
import { registerPgTools } from "./pg/tools.js";
import { VERSION } from "./version.js";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "kz-pgw-mcp", version: VERSION });
  registerBoTools(server);
  registerPgTools(server);
  return server;
}

export async function serve(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());

  const boMissing = missing(BO_KEYS);
  const pgMissing = missing(PG_KEYS);
  const lines = [
    `kz-pgw-mcp ${VERSION} ready`,
    `  config: ${loadedFrom.length ? loadedFrom.join(", ") : "env only"}`,
    `  backoffice: ${boMissing.length ? `NOT configured (missing ${boMissing.join(", ")})` : `ok, writes ${bo.allowWrites() ? "ENABLED" : "disabled"}`}`,
    `  staging db: ${pgMissing.length ? `NOT configured (missing ${pgMissing.join(", ")})` : `${pg.label()}${getTunnel() ? ` via ssh ${getTunnel()!.label}` : ""}, read-only`}`,
  ];
  if (boMissing.length || pgMissing.length) lines.push(`  fix: ${INIT_CMD}  (writes ${CONFIG_FILE})`);
  console.error(lines.join("\n"));

  const shutdown = (): void => void closePools().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

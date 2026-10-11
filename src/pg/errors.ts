import { spawn } from "node:child_process";

import { ConfigError, pg as cfg } from "../config.js";
import { SqlRejected } from "./db.js";

let lastVpnOpen = 0;

/** NordLayer on macOS has no CLI. Bring the app to front so the user clicks the gateway. */
function nudgeVpn(): string {
  const app = cfg.vpnApp();
  if (process.platform !== "darwin" || app === "") return "";
  const now = Date.now();
  if (now - lastVpnOpen > 60_000) {
    lastVpnOpen = now;
    spawn("open", ["-a", app], { stdio: "ignore", detached: true }).unref();
  }
  return ` VPN likely off. Opened ${app} — connect to gateway '${cfg.vpnGateway()}', then retry.`;
}

function isNetworkError(e: { code?: string; message?: string }): boolean {
  return (
    e.code === "ECONNREFUSED" ||
    e.code === "ENOTFOUND" ||
    e.code === "ETIMEDOUT" ||
    e.code === "EHOSTUNREACH" ||
    e.code === "ENETUNREACH" ||
    /timeout exceeded when trying to connect|connection timeout|connection terminated/i.test(e.message ?? "")
  );
}

export function formatPgError(error: unknown): string {
  if (error instanceof ConfigError) return `Error: ${error.message}`;
  if (error instanceof SqlRejected) return `Rejected: ${error.message}`;
  if (error && typeof error === "object" && ("code" in error || "message" in error)) {
    const e = error as { code?: string; message?: string; position?: string; hint?: string };
    if (isNetworkError(e)) return `Error: cannot reach ${cfg.label()} (${e.code ?? "connect timeout"}).${nudgeVpn()}`;
    switch (e.code) {
      case "57014":
        return `Error: query exceeded ${cfg.timeoutMs()} ms statement timeout. Add a WHERE clause or an index-friendly filter.`;
      case "25006":
        return "Error: write attempted in a read-only transaction. This server is read-only.";
      case "42P01":
        return `Error: ${e.message}. Use pg_list_tables to find the right name (names are case-sensitive when quoted).`;
      case "42703":
        return `Error: ${e.message}. Use pg_describe_table to see column names. camelCase columns must be double-quoted, e.g. "createdAt".`;
      case "ESSH":
        return `Error: ${e.message}. Check SSH_HOST/SSH_USER/SSH_PASSWORD and VPN.`;
      case "28P01":
        return "Error: password authentication failed. Check PGUSER/PGPASSWORD.";
      case "3D000":
        return `Error: ${e.message}. Use pg_list_databases to see valid names.`;
    }
    const pos = e.position ? ` (at char ${e.position})` : "";
    const hint = e.hint ? ` Hint: ${e.hint}` : "";
    return `Error ${e.code ?? ""}: ${e.message}${pos}.${hint}`;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * `kz-pgw-mcp install`             → Claude Desktop entry via npx (published package) + Claude Code command
 * `kz-pgw-mcp install --local`     → same, but points at THIS checkout's dist/cli.js (git clone, pre-publish)
 * `kz-pgw-mcp install --name NAME` → custom server name (default kz-pgw)
 *
 * No credentials are copied anywhere: the server reads ~/.config/kz-pgw/.env itself.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_FILE, PKG } from "./config.js";

function desktopConfigPath(): string | null {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return null;
  }
}

export async function install(args: string[]): Promise<void> {
  const nameIdx = args.indexOf("--name");
  const name = nameIdx >= 0 && args[nameIdx + 1] ? args[nameIdx + 1] : "kz-pgw";
  const local = args.includes("--local");

  // Claude Desktop does not inherit the shell PATH → absolute binaries.
  const nodeAbs = process.execPath;
  const npxAbs = join(dirname(nodeAbs), platform() === "win32" ? "npx.cmd" : "npx");
  const cliAbs = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

  const entry = local ? { command: nodeAbs, args: [cliAbs] } : { command: existsSync(npxAbs) ? npxAbs : "npx", args: ["-y", PKG] };
  const codeCmd = local ? `claude mcp add ${name} -- ${nodeAbs} ${cliAbs}` : `claude mcp add ${name} -- npx -y ${PKG}`;

  if (!existsSync(CONFIG_FILE)) console.log(`No config at ${CONFIG_FILE}. Run init first.\n`);

  const cfgPath = desktopConfigPath();
  if (cfgPath) {
    const cfg = existsSync(cfgPath) ? (JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>) : {};
    const servers = ((cfg.mcpServers as Record<string, unknown> | undefined) ??= {});
    servers[name] = entry;
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`Claude Desktop: wrote "${name}" → ${cfgPath}`);
    console.log(`  ${entry.command} ${entry.args.join(" ")}`);
    console.log("  Quit and reopen Claude Desktop.");
  } else {
    console.log("Claude Desktop: unsupported platform for auto-install. Add manually:");
    console.log(JSON.stringify({ mcpServers: { [name]: entry } }, null, 2));
  }

  console.log(`\nClaude Code:\n  ${codeCmd}`);
  console.log(`\nCursor / others (.mcp.json):\n${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}`);
  if (!local) console.log(`\nNote: npx needs a GitHub Packages token in ~/.npmrc for @valoquang. See README.`);
}

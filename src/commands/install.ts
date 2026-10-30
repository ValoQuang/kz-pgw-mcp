/**
 * `kz-pgw-mcp install`             → Claude Desktop entry via npx (published package) + Claude Code command
 * `kz-pgw-mcp install --local`     → same, but points at THIS checkout's dist/cli.js (git clone, pre-publish)
 * `kz-pgw-mcp install --name NAME` → custom server name (default kz-pgw)
 *
 * Also copies bundled skills (see skills/sync.ts).
 * No credentials are copied anywhere: the server reads ~/.config/kz-pgw/.env itself.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_MCP_NAME, PKG, PLUGIN, REPO } from "../core/constants.js";
import { CLI_JS, CONFIG_FILE } from "../core/paths.js";
import { syncSkillsReport } from "../skills/sync.js";

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

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function install(args: string[]): Promise<void> {
  const name = argValue(args, "--name") ?? DEFAULT_MCP_NAME;
  const local = args.includes("--local");

  // Claude Desktop does not inherit the shell PATH → absolute binaries.
  const nodeAbs = process.execPath;
  const npxAbs = join(dirname(nodeAbs), platform() === "win32" ? "npx.cmd" : "npx");

  const entry = local
    ? { command: nodeAbs, args: [CLI_JS] }
    : { command: existsSync(npxAbs) ? npxAbs : "npx", args: ["-y", PKG] };
  const codeCmd = `claude mcp add ${name} -- ${local ? `${nodeAbs} ${CLI_JS}` : `npx -y ${PKG}`}`;
  const mcpJson = JSON.stringify({ mcpServers: { [name]: entry } }, null, 2);

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
    console.log(`Claude Desktop: unsupported platform for auto-install. Add manually:\n${mcpJson}`);
  }

  console.log(`\nClaude Code:\n  ${codeCmd}`);
  console.log(`\nCursor / others (.mcp.json):\n${mcpJson}`);
  console.log(`\nSkills:\n  ${syncSkillsReport().join("\n  ")}`);
  if (!local) console.log(`\nClaude Code plugin (MCP + skills, recommended):\n  /plugin marketplace add ${REPO}\n  /plugin install ${PLUGIN}`);
}

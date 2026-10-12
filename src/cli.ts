#!/usr/bin/env node
/**
 * kz-pgw-mcp            start the MCP server (stdio)
 * kz-pgw-mcp init       interactive setup → ~/.config/kz-pgw/.env
 * kz-pgw-mcp doctor     show config and test the DB connection
 * kz-pgw-mcp install    register with Claude Desktop / print Claude Code command
 */

import { PKG } from "./core/constants.js";
import { VERSION } from "./core/version.js";

const [cmd = "serve", ...rest] = process.argv.slice(2);

switch (cmd) {
  case "serve":
    (await import("./server.js")).serve().catch((e: unknown) => {
      console.error("kz-pgw-mcp failed:", e);
      process.exit(1);
    });
    break;
  case "init":
    await (await import("./commands/init.js")).init(rest);
    break;
  case "doctor":
    await (await import("./commands/doctor.js")).doctor();
    break;
  case "install":
    await (await import("./commands/install.js")).install(rest);
    break;
  case "-v":
  case "--version":
    console.log(VERSION);
    break;
  default:
    console.log(`${PKG} ${VERSION}

Usage:
  npx -y ${PKG}            start MCP server (stdio)
  npx -y ${PKG} init       set up credentials (writes ~/.config/kz-pgw/.env)
  npx -y ${PKG} doctor     show config, test DB connection
  npx -y ${PKG} install    add to Claude Desktop / show Claude Code command
                                    --local  point at this checkout instead of npx (git clone)`);
    process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}

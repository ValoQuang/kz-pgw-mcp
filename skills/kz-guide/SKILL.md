---
name: "kz-guide"
description: "Quick guide for the kz-pgw plugin (KZ staging backoffice + PGW UAT tools). Use when the user asks how to use kz-pgw, what it can do, which skills exist, says \"help kz\", \"kz guide\", \"getting started\", or uses kz-pgw for the first time. Also handles the one-time role choice (project or dev) and changing it later."
---

# kz-pgw guide

## Steps
1. Call `kz_guide` (kz-pgw MCP). If deferred, load it with ToolSearch `select:mcp__kz-pgw__kz_guide`.
2. `roleSet` false → ask exactly: "One-time setup: are you **project** (PA / QA / PM, backoffice only) or **dev** (backoffice + staging DB)?" On the answer → `kz_set_role(role)`.
3. Show the `guide` text as-is. Add nothing before it. After it, one line: "Try: `login tpg1`".

## Change role
"set my kz role to dev / project" → `kz_set_role(role)`, then reply "Role: <role>." If dev and the DB is not configured: "Run `npx -y @valoquang/kz-pgw-mcp init` for the DB, then restart Claude."

## Skills
| Skill | Use for |
|---|---|
| `kz-guide` | This guide, role choice |
| `kz-create-orders` | Login, find test member, create deposit / withdraw |
| `kz-verify-orders` | UAT SOP (6 cases) and verdict: map a provider's orders to the cases, PASS / PENDING / FAIL |

MCP missing entirely → "kz-pgw MCP is not installed. Install the `.mcpb` (Claude Desktop) or run `claude mcp add kz-pgw -- npx -y @valoquang/kz-pgw-mcp` (Claude Code)."

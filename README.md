# @valoquang/kz-pgw-mcp

One MCP server for KZ payment-gateway work on staging. Merges `kz-bo-mcp` (backoffice API) and `kz-pg-mcp` (read-only Postgres).

| Tool | What | Needs |
|---|---|---|
| `bo_login` / `bo_submit_totp` / `bo_whoami` / `bo_logout` | Session per group against `https://api.<group>.trykz.dev` | BO creds |
| `bo_find_member` | Members with balance > N and a funding profile (reads `kz-<group>` DB) | DB creds |
| `bo_create_deposit` / `bo_create_withdraw` | Create real fundingTx on staging | BO creds + **writes enabled** |
| `bo_api` | Raw authenticated call. GET always; non-GET needs **writes enabled** | BO creds |
| `pg_query` / `pg_list_databases` / `pg_list_tables` / `pg_describe_table` | Read-only SQL. Keyword guard + `BEGIN READ ONLY`, 30 s timeout, 200 rows default | DB creds |

Writes are **off by default**. `KZ_PGW_ALLOW_WRITES=true` turns them on.

## Install (users)

Two ways. Both ask for every credential; nothing is baked into the package.

### A. Claude Desktop — `.mcpb` (no terminal)

1. Download `kz-pgw-mcp.mcpb` from the latest [GitHub release](https://github.com/ValoQuang/kz-pgw-mcp/releases).
2. Double-click it (or Claude Desktop → Settings → Extensions → Install).
3. Claude shows a form: BO username/password, PG host/user/password, SSH jump host, "Enable write tools". Passwords are stored in the OS keychain.
4. Done. Tools appear as `kz-pgw-mcp`.

Change a value later: Settings → Extensions → kz-pgw-mcp → Configure.

### B. Claude Code / Cursor / anything else — `npx`

One-time: a GitHub token with `read:packages` in `~/.npmrc`:

```
@valoquang:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_xxx
```

Then:

```bash
npx -y @valoquang/kz-pgw-mcp init      # prompts for everything → ~/.config/kz-pgw/.env (chmod 600)
npx -y @valoquang/kz-pgw-mcp doctor    # prints config (secrets masked), runs SELECT 1
npx -y @valoquang/kz-pgw-mcp install   # writes Claude Desktop entry, prints Claude Code command
```

Claude Code manually:

```bash
claude mcp add kz-pgw -- npx -y @valoquang/kz-pgw-mcp
```

Re-run `init` any time; Enter keeps the current value.

If config is missing, the server still starts. Every tool answers `not configured: missing X. Run npx -y @valoquang/kz-pgw-mcp init` instead of crashing.

## Config

Priority: env vars → `$KZ_PGW_CONFIG` → `~/.config/kz-pgw/.env` → `<package>/.env` (dev).

| Var | Default | Note |
|---|---|---|
| `KZ_USERNAME`, `KZ_PASSWORD` | — | BO staff login, same for all groups |
| `KZ_STAGING_DOMAIN` | `trykz.dev` | |
| `KZ_PGW_ALLOW_WRITES` | `false` | `true` enables deposit / withdraw / non-GET `bo_api` |
| `KZ_TOTP_SECRET_<GROUP>` | — | Base32. Set → `bo_login` finishes 2FA itself |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE` | `5432`, `postgres`, `require` | pgAdmin → kz-api-global → Connection tab |
| `KZ_PG_DB_TEMPLATE` | `kz-{group}` | Database used by `bo_find_member` |
| `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD` / `SSH_KEY_PATH` | `22`, `ubuntu` | Empty `SSH_HOST` = direct connect |
| `PG_MCP_LABEL` | `$PGDATABASE@$PGHOST` | Shown in tool descriptions |
| `PG_MCP_TIMEOUT_MS` | `30000` | |
| `PG_MCP_VPN_APP`, `PG_MCP_VPN_GATEWAY` | `NordLayer`, `s5tech-VPS` | macOS: app opened on connection error. `""` disables |
| `KZ_SKILLS_DIR` | `~/.claude/skills` | Where bundled skills are copied. `off` = don't copy |

VPN: staging is only reachable on NordLayer. On a network error the server opens NordLayer and tells you which gateway to click.

### C. From a git clone (pre-publish / contributors)

```bash
git clone git@github.com:ValoQuang/kz-pgw-mcp.git && cd kz-pgw-mcp
yarn install && yarn build
node dist/cli.js init
node dist/cli.js doctor
node dist/cli.js install --local   # Desktop entry points at this checkout's dist/cli.js
```

## Skills

`skills/` holds Claude skills that drive this MCP. Shipped in the npm package and `.mcpb`.

Auto-installed to `~/.claude/skills/` (configurable) on `install` and on every server start. Restart Claude once after the first start to load them.
- Updates when the package version changes. Skills removed from the package are deleted.
- Only touches folders it created (marker file `.kz-pgw-mcp`). Your own skill with the same name is never overwritten.
- Folder: `KZ_SKILLS_DIR` (asked by `init`, or "Claude skills folder" in the `.mcpb` settings). Blank = `~/.claude/skills`. `off` = don't copy.
- Claude Desktop **chat** (not Code tab) does not read `~/.claude/skills/`. Upload there by hand: zip each folder → Settings → Capabilities → Skills.

| Skill | Use |
|---|---|
| `kz-bo-login` | "Quangy, login tpg1 / make a 300 deposit / check this tx" — BO + PG operator |
| `kz-sql` | Read-only staging SQL. Real schema, enums, query templates (`references/`) |
| `kz-pgw-issue` | Diagnose stuck / failed / duplicate deposits and withdrawals |

## Develop

```bash
yarn install
yarn build
yarn check                         # SQL guard tests
node scripts/smoke.mjs             # no creds: 12 tools listed, write gate, missing-config messages
node scripts/smoke.mjs --live      # uses ~/.config/kz-pgw/.env, needs VPN
npm run inspect                    # MCP Inspector
```

Layout:

```
src/
  cli.ts              entry: serve | init | doctor | install
  server.ts           McpServer: registers bo_* + pg_* tools, syncs skills, status → stderr
  core/               shared, no MCP or DB code
    constants.ts      package name, tool names, timeouts, row limits, annotation presets
    env.ts            every env var: key, default, comment, secret. Feeds config, init, doctor
    config.ts         loads .env files, typed accessors (bo, pg, ssh, skills), ConfigError
    paths.ts          package root, ~/.config/kz-pgw, ~/.claude, expandHome
    result.ts         ok / fail / safely (try/catch → tool error)
    version.ts        version from package.json
  commands/           CLI subcommands
    init.ts           interactive setup → ~/.config/kz-pgw/.env
    doctor.ts         config summary + DB connection test
    install.ts        Claude Desktop entry + Claude Code command + skills
    prompt.ts         readline helpers (no deps)
  bo/                 backoffice API
    http.ts           JSON fetch
    auth.ts           OAuth + TOTP sessions per group
    api.ts            authenticated call
    totp.ts           RFC 6238 codes
    tools.ts          bo_* tools
  pg/                 staging Postgres, read-only
    db.ts             pools, read-only tx, catalog queries
    guard.ts          SQL allow-list
    tunnel.ts         SSH jump host
    errors.ts         error → one actionable line, VPN nudge
    tools.ts          pg_* tools
  skills/sync.ts      copies skills/ → KZ_SKILLS_DIR
skills/               bundled Claude skills (kz-bo-login, kz-sql, kz-pgw-issue)
manifest.json         .mcpb user_config form for Claude Desktop
```

New env var: add it to `src/core/env.ts`, then an accessor in `config.ts`. `init` and `doctor` pick it up. Update `manifest.json` and `.env.example` by hand.

## Release

```bash
npm version patch            # bumps package.json; also bump manifest.json "version"
git push --follow-tags
```

`.github/workflows/publish.yml` on tag `v*`: build → check → smoke → `npm publish` to GitHub Packages → pack `.mcpb` → attach to GitHub release.

Local `.mcpb` build: `npm run mcpb` → `dist-mcpb/kz-pgw-mcp.mcpb` (bundles `node_modules`, ~10 MB).

## Security notes

- Ask DevOps for a `SELECT`-only Postgres role for `PGUSER`. The server enforces read-only twice, but a read-only role removes the risk entirely.
- `bo_create_deposit` / `bo_create_withdraw` create real transactions on staging. Keep `KZ_PGW_ALLOW_WRITES` off unless you need them that day.
- The package is private (GitHub Packages, `access: restricted`). Credentials never leave the user's machine: `~/.config/kz-pgw/.env` (600) or the OS keychain via `.mcpb`.

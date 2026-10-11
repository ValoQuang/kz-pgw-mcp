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

VPN: staging is only reachable on NordLayer. On a network error the server opens NordLayer and tells you which gateway to click.

### C. From a git clone (pre-publish / contributors)

```bash
git clone git@github.com:ValoQuang/kz-pgw-mcp.git && cd kz-pgw-mcp
yarn install && yarn build
node dist/cli.js init
node dist/cli.js doctor
node dist/cli.js install --local   # Desktop entry points at this checkout's dist/cli.js
```

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
  cli.ts        serve | init | doctor | install
  config.ts     env loading, accessors, ConfigError
  server.ts     McpServer + both tool sets
  bo/           auth (OAuth+TOTP), api, tools
  pg/           db (pool, tunnel, read-only tx), guard, errors, tools
  init.ts       interactive setup → ~/.config/kz-pgw/.env
  prompt.ts     readline helpers (no deps)
manifest.json   .mcpb user_config form for Claude Desktop
```

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

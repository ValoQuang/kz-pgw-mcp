# @valoquang/kz-pgw-mcp

One MCP server for KZ payment-gateway work on **staging** (`*.trykz.dev`). Backoffice API + read-only Postgres + 4 Claude skills that drive them.

- 13 tools: `bo_*` (backoffice) and `pg_*` (Postgres).
- 4 skills: `kz-bo-pgw`, `kz-sql`, `kz-pgw-issue`, `kz-pgw-uat`. Auto-copied to `~/.claude/skills/`.
- Writes (deposit, withdraw, non-GET API) are **off by default**.
- Staging only. Needs NordLayer VPN.

## Contents

1. [Quick start](#quick-start)
2. [Install](#install)
3. [Tools](#tools)
4. [Skills](#skills)
5. [Config](#config)
6. [Troubleshooting](#troubleshooting)
7. [Develop](#develop)
8. [Release](#release)
9. [Security](#security)

## Quick start

Claude Code, 4 steps:

1. Add a GitHub token with `read:packages` to `~/.npmrc` ([details](#b-claude-code--cursor--others--npx)).
2. Set up credentials:
   ```bash
   npx -y @valoquang/kz-pgw-mcp init
   ```
3. Check the config and DB connection (connect NordLayer first):
   ```bash
   npx -y @valoquang/kz-pgw-mcp doctor
   ```
4. Register the server, then restart Claude:
   ```bash
   claude mcp add kz-pgw -- npx -y @valoquang/kz-pgw-mcp
   ```

Try it:

```
login tpg1
find a test member with balance over 1000 on tpg1
check tx TPG1XFW123 on tpg1
why is deposit TPG1XFW123 stuck?
```

## Install

Every method asks for credentials. Nothing is baked into the package.

### A. Claude Desktop — `.mcpb` (no terminal)

1. Download `kz-pgw-mcp.mcpb` from the latest [GitHub release](https://github.com/ValoQuang/kz-pgw-mcp/releases).
2. Double-click it, or Claude Desktop → Settings → Extensions → Install.
3. Fill the form: BO username/password, PG host/user/password, SSH jump host, "Enable write tools". Passwords go to the OS keychain.
4. Tools appear under `kz-pgw-mcp`.

Change a value later: Settings → Extensions → kz-pgw-mcp → Configure.

### B. Claude Code / Cursor / others — `npx`

One-time: GitHub token with `read:packages` in `~/.npmrc`:

```
@valoquang:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_xxx
```

Then:

```bash
npx -y @valoquang/kz-pgw-mcp init
```

```bash
npx -y @valoquang/kz-pgw-mcp doctor
```

```bash
npx -y @valoquang/kz-pgw-mcp install
```

| Command | Does |
|---|---|
| `init` | Prompts for every value → `~/.config/kz-pgw/.env` (chmod 600). Re-run any time; Enter keeps the current value |
| `doctor` | Prints config (secrets masked), runs `SELECT 1` |
| `install` | Writes the Claude Desktop entry, prints the Claude Code command and `.mcp.json` snippet, copies skills |
| `install --name X` | Same, custom server name (default `kz-pgw` → tools appear as `mcp__kz-pgw__*`) |
| `install --local` | Points at a git checkout's `dist/cli.js` instead of npx |
| *(no args)* | Starts the MCP server on stdio |

Claude Code by hand:

```bash
claude mcp add kz-pgw -- npx -y @valoquang/kz-pgw-mcp
```

Cursor / others (`.mcp.json`):

```json
{ "mcpServers": { "kz-pgw": { "command": "npx", "args": ["-y", "@valoquang/kz-pgw-mcp"] } } }
```

Config missing? The server still starts. Each tool replies `not configured: missing X. Run npx -y @valoquang/kz-pgw-mcp init` instead of crashing.

### C. From a git clone (contributors, pre-publish)

```bash
git clone git@github.com:ValoQuang/kz-pgw-mcp.git && cd kz-pgw-mcp
```

```bash
yarn install && yarn build
```

```bash
node dist/cli.js init && node dist/cli.js doctor && node dist/cli.js install --local
```

## Tools

`group` = staging group code, `t` + 2 letters + optional digit: `tpg1`, `ttg1`, `tig1`, `tco`, `tpk1`, `tph1`, `tth1`, `tbd1`, `tgg`, `tpe`. API = `https://api.<group>.trykz.dev`. DB = `kz-<group>`.

### Backoffice (`bo_*`)

| Tool | Args | Does | Write? |
|---|---|---|---|
| `bo_login` | `group` | Starts login with `KZ_USERNAME` / `KZ_PASSWORD`. Finishes TOTP itself if `KZ_TOTP_SECRET_<GROUP>` is set. Returns `totpRequired`, `autoTotp` | — |
| `bo_submit_totp` | `group`, `totp` (6 digits) | Finishes login when `totpRequired=true` | — |
| `bo_whoami` | — | Cached sessions, seconds left, `writesEnabled` | — |
| `bo_check_access` | `group` | Reads `kz-<group>`: may your staff login create deposits / withdraws? Needs `account:deposit-creator` / `account:withdrawal-creator` or `platform:super-admin` | — |
| `bo_logout` | `group` | Drops the cached token | — |
| `bo_find_member` | `group`, `minBalance` (1000), `profileType` (`bank` \| `e-wallet`), `limit` (15, max 50) | Members with balance > N and a funding profile. Reads `kz-<group>` DB | — |
| `bo_create_deposit` | `group`, `memberId`, `fundingProfileId`, `amount`, `method`, `providerRef?`, `remark?`, `memo?`, `date?` | `POST /account/funding/tx/deposit`. Real tx on staging. Stops first if you lack `account:deposit-creator` | **Yes** |
| `bo_create_withdraw` | `group`, `memberId`, `fundingProfileId`, `amount`, `method?`, `remark?`, `memo?` | `POST /account/funding/tx/withdraw`. May land in `pending-audit`. Stops first if you lack `account:withdrawal-creator` | **Yes** |
| `bo_api` | `group`, `method` (GET), `path`, `body?` | GET: any kz-api path. Non-GET: only `POST /account/funding/tx/deposit` and `/withdraw`, with the same privilege check. Adjust, approve, reject, privileges, settings → refused, use the BO web app | Non-GET only |

Login flow: `bo_login` → if `totpRequired` and not `autoTotp`, get the code → `bo_submit_totp`. Tokens last about 24 h.

### Postgres (`pg_*`, read-only)

| Tool | Args | Does |
|---|---|---|
| `pg_list_databases` | — | All DBs on the cluster with size |
| `pg_list_tables` | `database`, `schema` (public), `pattern?` (ILIKE) | Tables / views with estimated rows |
| `pg_describe_table` | `table`, `database`, `schema` | Columns, PK, indexes, FKs |
| `pg_query` | `sql`, `database`, `max_rows` (200, max 1000) | One read-only statement. Returns `columns`, `rows`, `truncated`, `duration_ms` |

`pg_query` safety: allow-list (`SELECT`, `WITH`, `EXPLAIN`, `SHOW`, `VALUES`, `TABLE`), one statement, `BEGIN READ ONLY`, 30 s timeout. Columns are camelCase — quote them: `"createdAt"`. bigint / numeric / timestamps come back as strings.

## Skills

`skills/` ships with the npm package and the `.mcpb`. Each skill tells Claude how to use the tools above.

| Skill | Say this | Does |
|---|---|---|
| `kz-bo-pgw` | "login tpg1" / "make a 300 deposit on tpg1" / "find a test member" | BO + PG operator. Handles login and TOTP. Confirms every write in one line before running it |
| `kz-sql` | "check tx TPG1XFW…" / "status timeline of …" / "count deposits by status on ttg1" | Read-only SQL. Real schema, enums, 14 query templates in `references/` |
| `kz-pgw-issue` | "analyze this PGW issue: …" / "why is withdraw X stuck?" | Diagnoses stuck, failed, duplicate or early-settled deposits / withdrawals. Outputs root cause, client actions, SQL, Slack draft |
| `kz-pgw-uat` | "what are the UAT cases?" / "verify UAT for cpay-2 on tpg1 since 2026-10-20" | Shows the 6-case UAT SOP (OS-52). Maps the client's orders to the cases, gives PASS / PENDING / FAIL |

### `kz-bo-pgw`

Backoffice operator for PGW testing on staging.

| Say | Does | Tool |
|---|---|---|
| "login tpg1" / "am I logged in" | Login + TOTP, or show sessions and time left | `bo_login`, `bo_submit_totp`, `bo_whoami` |
| "find a test member" | Members with balance > 1000 and a bank profile | `bo_find_member` |
| "can I deposit on tpg1?" | Your write privileges on that group, from the DB | `bo_check_access` |
| "make a 300 deposit on tpg1" | Checks privilege → create a deposit (confirms first) | `bo_check_access`, `bo_create_deposit` |
| "withdraw 200 for member X" | Checks privilege → create a withdraw, may land in `pending-audit` (confirms first) | `bo_create_withdraw` |
| "GET /account/funding/tx?memberId=…" | Any backoffice read not wrapped yet | `bo_api` |
| "check tx X" / "balance of member X" | Hands off to `kz-sql` | `pg_*` |

- Defaults: group `tpg1`, method `cpay-2/bank-transfer`, profile type `bank`.
- Reads run at once. Writes show `Create deposit: <amount> via <method> on <group> → member … ok?` and wait for "ok" / "yes" / "go".
- Asks `TOTP for <group>?` when 2FA is needed. Reply with the 6 digits.
- Never retries a failed write. Never runs a write on a group you did not name.

### `kz-sql`

- Picks DB `kz-<group>` (default `kz-tpg1`), adapts a template from `references/queries.md`, runs `pg_describe_table` before guessing a column.
- Big DBs `kz-tph1` (81 GB) and `kz-tth1` (417 GB): always a `"createdAt"` window ≤ 7 days.
- Masks secrets. Shows PII only when you ask about that member.
- Files: `references/schema.md` (tables, enums, joins), `references/queries.md` (templates).

### `kz-pgw-issue`

Give it:

```
Analyze this PGW issue:
- Description: Player withdrew 500 THB via Bank A, stuck in pending
- Transaction ID: TTG1XFW123
- Time window: 2026-09-27 14:00-15:00 UTC
- Provider: Bank A
- Brand: thkzg1
```

It reads the `activityLog` status timeline first, then `fundingTx`, then `fundingNotification` webhooks, and maps the pattern to a cause.

### `kz-pgw-uat`

UAT passes only when the client ran every case in the Member Portal. Staff-made orders never count.

| # | Case | Pass when |
|---|---|---|
| C1 | Deposit success | `completed` after callback |
| C2 | Deposit rejected | `error` after callback |
| C3 | Withdraw success | `completed` after callback |
| C4 | Withdraw rejected | `pending-audit` after callback |
| C5 | Paid ≠ entered amount | credited = paid amount (`netAmount`) |
| C6 | 3rd balance | BO balance = provider BO balance |

Full SOP (how to run each case, region extras, before / after UAT): [`skills/kz-pgw-uat/references/uat-sop.md`](skills/kz-pgw-uat/references/uat-sop.md).

### Where skills go

- Copied to `~/.claude/skills/` on `install` and on every server start. Restart Claude once after the first start.
- Updated when the package version changes. Skills removed from the package are deleted.
- Only folders with marker file `.kz-pgw-mcp` are touched. Your own skill with the same name is never overwritten.
- Change the folder with `KZ_SKILLS_DIR` (`init` asks; `.mcpb` field "Claude skills folder"). `off` = don't copy.
- Claude Desktop **chat** (not the Code tab) does not read `~/.claude/skills/`. Upload by hand: zip each folder → Settings → Capabilities → Skills.

## Config

Load order: env vars → `$KZ_PGW_CONFIG` → `~/.config/kz-pgw/.env` → `<package>/.env` (dev). Template: [.env.example](.env.example).

| Var | Default | Note |
|---|---|---|
| `KZ_USERNAME`, `KZ_PASSWORD` | — | BO staff login, same for all groups |
| `KZ_STAGING_DOMAIN` | `trykz.dev` | |
| `KZ_PGW_ALLOW_WRITES` | `false` | `true` enables deposit, withdraw, non-GET `bo_api`. Restart after change |
| `KZ_TOTP_SECRET_<GROUP>` | — | Base32, e.g. `KZ_TOTP_SECRET_TPG1`. Set → `bo_login` does 2FA itself |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE` | —, `5432`, `postgres`, —, —, `require` | pgAdmin → kz-api-global → Connection tab |
| `KZ_PG_DB_TEMPLATE` | `kz-{group}` | DB used by `bo_find_member` |
| `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD` / `SSH_KEY_PATH` | —, `22`, `ubuntu` | Empty `SSH_HOST` = direct connect |
| `PG_MCP_LABEL` | `$PGDATABASE@$PGHOST` | Shown in tool descriptions |
| `PG_MCP_TIMEOUT_MS` | `30000` | Query timeout |
| `PG_MCP_VPN_APP`, `PG_MCP_VPN_GATEWAY` | `NordLayer`, `s5tech-VPS` | macOS: app opened on network error. `""` disables |
| `KZ_SKILLS_DIR` | `~/.claude/skills` | `off` = don't copy skills |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `not configured: missing X` | Run `init`, restart Claude |
| Network / connect error, NordLayer pops up | Connect NordLayer gateway `s5tech-VPS`, retry |
| `Write tools are disabled` | Set `KZ_PGW_ALLOW_WRITES=true` in `~/.config/kz-pgw/.env`, restart Claude |
| BO call returns 401 | Token expired (~24 h). `bo_login` again |
| `bo_login` keeps asking for TOTP | Add `KZ_TOTP_SECRET_<GROUP>`, or answer with `bo_submit_totp` |
| `npx` 401 / 404 | `~/.npmrc` token missing or lacks `read:packages` |
| Skills not showing | Restart Claude once after first server start. Desktop chat: upload zip by hand |
| Tool call hangs in Desktop | Look for a pending approval prompt |
| Anything else | `npx -y @valoquang/kz-pgw-mcp doctor` |

## Develop

```bash
yarn install && yarn build
```

| Command | Does |
|---|---|
| `yarn dev` | Run from source with tsx |
| `yarn check` | SQL guard tests |
| `node scripts/smoke.mjs` | No creds: 13 tools listed, write gate, missing-config messages |
| `node scripts/smoke.mjs --live` | Uses `~/.config/kz-pgw/.env`, needs VPN |
| `yarn inspect` | MCP Inspector |

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
skills/               bundled Claude skills (kz-bo-pgw, kz-sql, kz-pgw-issue, kz-pgw-uat)
manifest.json         .mcpb user_config form for Claude Desktop
```

Add an env var: `src/core/env.ts` → accessor in `config.ts`. `init` and `doctor` pick it up. Update `manifest.json` and `.env.example` by hand.

Add a tool: name in `TOOLS` (`constants.ts`) → register in `bo/tools.ts` or `pg/tools.ts` → add it to the `want` list in `scripts/smoke.mjs` and to this README.

Add a skill: new folder `skills/<name>/SKILL.md`. Shipped and synced automatically.

## Release

```bash
npm version patch
```

Also bump `"version"` in `manifest.json`, then:

```bash
git push --follow-tags
```

`.github/workflows/publish.yml` on tag `v*`: build → check → smoke → `npm publish` to GitHub Packages → pack `.mcpb` → attach to the GitHub release.

Local `.mcpb`: `yarn mcpb` → `dist-mcpb/kz-pgw-mcp.mcpb` (~10 MB, bundles `node_modules`).

## Security

- **DB login:** `PGUSER` is your own existing staging login. Devs may have write access; QA use their read-only account. Either way the MCP itself is read-only: SQL keyword guard + `BEGIN READ ONLY` + 30 s timeout.
- **Prompt injection:** DB rows and webhooks can carry text aimed at Claude. Limits: non-GET `bo_api` only reaches deposit / withdraw; write tools are marked destructive. Never set `bo_create_*` or `bo_api` to "always allow" in Claude permissions, so you see every write before it runs.
- **Who can write:** nobody writes the DB through this MCP. Deposits / withdrawals go through the BO API as your own staff account (password + TOTP). Before sending, `bo_create_deposit` / `bo_create_withdraw` read your privileges from `kz-<group>` (`entityHasPrivilege`, same source kz-api uses) and stop if you lack `account:deposit-creator` / `account:withdrawal-creator`. kz-api checks again on the server.
- `bo_create_deposit` / `bo_create_withdraw` create real staging transactions. Keep `KZ_PGW_ALLOW_WRITES` off unless you need it that day.
- Private package (GitHub Packages, `access: restricted`). Credentials stay on your machine: `~/.config/kz-pgw/.env` (600) or the OS keychain via `.mcpb`.

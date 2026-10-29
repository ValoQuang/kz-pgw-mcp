# @valoquang/kz-pgw-mcp

One MCP server for KZ payment-gateway work on **staging** (`*.trykz.dev`). Backoffice API, PGW UAT verification, and read-only Postgres for devs. Plus 3 Claude skills.

- **Role, asked once:** `project` (PA / QA / PM: backoffice login only, no DB setup) or `dev` (backoffice + read-only DB).
- 17 tools: `kz_*` (guide, role), `bo_*` (backoffice) and `pg_*` (Postgres, dev).
- 3 skills: `kz-guide`, `kz-create-orders`, `kz-pgw-uat`. Auto-copied to `~/.claude/skills/`.
- First use shows a short guide.
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
2. Set up. First question is your role. `project` only asks for the backoffice login:
   ```bash
   npx -y @valoquang/kz-pgw-mcp init
   ```
3. Check the config (connect NordLayer first; `dev` also tests the DB):
   ```bash
   npx -y @valoquang/kz-pgw-mcp doctor
   ```
4. Register the server, then restart Claude:
   ```bash
   claude mcp add kz-pgw -- npx -y @valoquang/kz-pgw-mcp
   ```

Skipped `init` (e.g. `.mcpb` with an empty role)? Claude asks "project or dev?" on the first call and saves the answer.

Try it:

```
how do I use kz-pgw?
login tpg1
make a 300 deposit on tpg1 via cpay-2
verify UAT for cpay-2 on tpg1 since 2026-10-20
```

## Install

Every method asks for credentials. Nothing is baked into the package.

### A. Claude Desktop — `.mcpb` (no terminal)

1. Download `kz-pgw-mcp.mcpb` from the latest [GitHub release](https://github.com/ValoQuang/kz-pgw-mcp/releases).
2. Double-click it, or Claude Desktop → Settings → Extensions → Install.
3. Fill the form. Role: `project` or `dev`. `project` → fill only BO username/password; leave PG / SSH empty. `dev` → also PG host/user/password and SSH jump host. Passwords go to the OS keychain.
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
| `init` | Asks role first, then only what that role needs → `~/.config/kz-pgw/.env` (chmod 600). Re-run any time; Enter keeps the current value |
| `doctor` | Prints role + config (secrets masked). `dev`: runs `SELECT 1` |
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

### Role and guide (`kz_*`)

| Tool | Args | Does |
|---|---|---|
| `kz_guide` | — | Short guide: role, login, skills, rules, fixes. Shown on first use |
| `kz_set_role` | `role` (`project` \| `dev`) | Saves `KZ_ROLE` to `~/.config/kz-pgw/.env`. Shows / hides `pg_*` at once |

No role yet → every other tool answers "Role not set" and Claude asks once.

| | project | dev |
|---|---|---|
| Setup asks for | BO login | BO login + PG + SSH |
| `bo_*` | all | all |
| `bo_find_member` | via BO API | via DB |
| `bo_check_access` | not pre-checked (kz-api returns 403) | DB read |
| `pg_*` | hidden | yes |

### Backoffice (`bo_*`)

| Tool | Args | Does | Write? |
|---|---|---|---|
| `bo_login` | `group` | Starts login with `KZ_USERNAME` / `KZ_PASSWORD`. Finishes TOTP itself if `KZ_TOTP_SECRET_<GROUP>` is set. Returns `totpRequired`, `autoTotp` | — |
| `bo_submit_totp` | `group`, `totp` (6 digits) | Finishes login when `totpRequired=true` | — |
| `bo_whoami` | — | Cached sessions, seconds left, `writesEnabled` | — |
| `bo_check_access` | `group` | dev: reads `kz-<group>`: may your staff login create deposits / withdraws? Needs `account:deposit-creator` / `account:withdrawal-creator` or `platform:super-admin`. project: returns nulls + note | — |
| `bo_logout` | `group` | Drops the cached token | — |
| `bo_find_member` | `group`, `minBalance` (1000), `profileType` (`bank` \| `e-wallet`), `limit` (15, max 50) | Members with balance > N and a funding profile. dev: `kz-<group>` DB. project: BO API (scans 40 members) | — |
| `bo_list_methods` | `group`, `provider?` (key or name), `type?` | `GET /account/funding/method/list`. Resolves a provider name (`Cpay`) to its key (`cpay-2`) and lists method keys | — |
| `bo_list_orders` | `group`, one of `provider` (key or name, needs `since`) / `orderRef` (comma list) / `memberId`, `since?`, `until?`, `type` (`all`), `status?`, `limit` (100, max 500) | `GET /account/funding/tx/list`. Each order: status, amounts, `providerRef`, `creatorId` (null = player in MP), `callbackToDoneSec`. Plus counts per type / status. No `since` → newest first. No `providerRef` filter (API has none) | — |
| `bo_create_deposit` | `group`, `memberId`, `fundingProfileId`, `amount`, `method`, `providerRef?`, `remark?`, `memo?`, `date?` | `POST /account/funding/tx/deposit`. Real tx on staging. Stops first if you lack `account:deposit-creator` | **Yes** |
| `bo_create_withdraw` | `group`, `memberId`, `fundingProfileId`, `amount`, `method?`, `remark?`, `memo?` | `POST /account/funding/tx/withdraw`. May land in `pending-audit`. Stops first if you lack `account:withdrawal-creator` | **Yes** |
| `bo_api` | `group`, `method` (GET), `path`, `body?` | GET: any kz-api path. Non-GET: only `POST /account/funding/tx/deposit` and `/withdraw`, with the same privilege check. Adjust, approve, reject, privileges, settings → refused, use the BO web app | Non-GET only |

Login flow: `bo_login` → if `totpRequired` and not `autoTotp`, get the code → `bo_submit_totp`. Tokens last about 24 h.

### Postgres (`pg_*`, read-only, dev role)

| Tool | Args | Does |
|---|---|---|
| `pg_list_databases` | — | All DBs on the cluster with size |
| `pg_list_tables` | `database`, `schema` (public), `pattern?` (ILIKE) | Tables / views with estimated rows |
| `pg_describe_table` | `table`, `database`, `schema` | Columns, PK, indexes, FKs |
| `pg_query` | `sql`, `database`, `max_rows` (200, max 1000) | One read-only statement. Returns `columns`, `rows`, `truncated`, `duration_ms` |

## Skills

`skills/` ships with the npm package and the `.mcpb`. Each skill tells Claude how to use the tools above. All skills ask the role once, then show the guide.

| Skill | Say this | Does |
|---|---|---|
| `kz-guide` | "how do I use kz-pgw?" / "kz guide" / "set my kz role to dev" | Shows the quick guide. Asks / changes the role |
| `kz-create-orders` | "login tpg1" / "make a 300 deposit on tpg1 via cpay-2" / "find a test member" | Login + TOTP, find a member, create deposit / withdraw. Confirms every write in one line first. Renamed from `kz-bo-pgw` |
| `kz-pgw-uat` | "what are the UAT cases?" / "verify UAT for cpay-2 on tpg1 since 2026-10-20" | Shows the 6-case UAT SOP (OS-52). Maps the client's orders to the cases, checks the 3rd balance, gives PASS / PENDING / FAIL. dev reads the DB, project the BO API |

### `kz-pgw-uat`

UAT passes only when the client ran every case in the Member Portal (`creatorId` null). Staff-made orders are listed but never count.

| # | Case (OS-52) | Matching order | No order → |
|---|---|---|---|
| C1 | Deposit success | deposit · `completed` · callback received | ❌ missing |
| C2 | Deposit rejected | deposit · `error` · callback received | ⏳ ask provider if supported; no → N/A |
| C3 | Withdraw success | withdraw · `completed` · callback received | ❌ missing |
| C4 | Withdraw rejected | withdraw · `pending-audit` · callback received | ❌ missing |
| C5 | Paid ≠ entered amount | deposit · `completed` · `netAmount` ≠ `reqAmount` | ⏳ ask provider if supported; no → N/A |
| C6 | 3rd balance | balance sync works (dev: `fundingProvider`; project: `GET /platform/funding/provider/balance/list`) and a person confirms it matches the provider BO | ⏳ |

Flags that fail UAT: callback → done > 120 s, `netAmount` > `reqAmount`, amount off by ×100, `pending` / `processing` > 30 min.

- **PASS:** C1–C6 ✅ or N/A, no flags.
- **PENDING:** C1, C3, C4 met, no flags, C2 / C5 / C6 still ⏳.
- **FAIL:** C1, C3 or C4 missing, C6 ❌, or any flag.

Full SOP (how to run each case, region extras, before / after UAT): [`skills/kz-pgw-uat/references/uat-sop.md`](skills/kz-pgw-uat/references/uat-sop.md).

### Where skills go

- Copied to `~/.claude/skills/` on `install` and on every server start. Restart Claude once after the first start.
- Updated when the package version changes. Skills removed from the package are deleted (0.2.0 removes `kz-bo-pgw`, `kz-sql`, `kz-pgw-issue`; `kz-bo-pgw` is now `kz-create-orders`).
- Only folders with marker file `.kz-pgw-mcp` are touched. Your own skill with the same name is never overwritten. To keep an old one: delete its `.kz-pgw-mcp` file before upgrading.
- Change the folder with `KZ_SKILLS_DIR` (`init` asks; `.mcpb` field "Claude skills folder"). `off` = don't copy.
- Claude Desktop **chat** (not the Code tab) does not read `~/.claude/skills/`. Upload by hand: zip each folder → Settings → Capabilities → Skills.

## Config

Load order: env vars → `$KZ_PGW_CONFIG` → `~/.config/kz-pgw/.env` → `<package>/.env` (dev). Template: [.env.example](.env.example).

| Var | Default | Note |
|---|---|---|
| `KZ_ROLE` | — | `project` or `dev`. Blank = asked in Claude on first use |
| `KZ_USERNAME`, `KZ_PASSWORD` | — | BO staff login, same for all groups |
| `KZ_STAGING_DOMAIN` | `trykz.dev` | |
| `KZ_PGW_ALLOW_WRITES` | `false` | `true` enables deposit, withdraw, non-GET `bo_api`. Restart after change |
| `KZ_TOTP_SECRET_<GROUP>` | — | Base32, e.g. `KZ_TOTP_SECRET_TPG1`. Set → `bo_login` does 2FA itself |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE` | —, `5432`, `postgres`, —, —, `require` | dev only. pgAdmin → kz-api-global → Connection tab |
| `KZ_PG_DB_TEMPLATE` | `kz-{group}` | DB used by `bo_find_member` |
| `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD` / `SSH_KEY_PATH` | —, `22`, `ubuntu` | Empty `SSH_HOST` = direct connect |
| `PG_MCP_LABEL` | `$PGDATABASE@$PGHOST` | Shown in tool descriptions |
| `PG_MCP_TIMEOUT_MS` | `30000` | Query timeout |
| `PG_MCP_VPN_APP`, `PG_MCP_VPN_GATEWAY` | `NordLayer`, `s5tech-VPS` | macOS: app opened on network error. `""` disables |
| `KZ_SKILLS_DIR` | `~/.claude/skills` | `off` = don't copy skills |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Role not set` | Answer "project" or "dev" in Claude, or run `init` |
| `not configured: missing X` | Run `init`, restart Claude |
| project role, but need SQL | "set my kz role to dev", then `init` for the DB |
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
| `yarn check` | SQL guard + bo_api path tests |
| `node scripts/smoke.mjs` | No creds: 17 tools listed, role gate, project / dev tool lists, write gate, missing-config messages |
| `node scripts/smoke.mjs --live` | Uses `~/.config/kz-pgw/.env`, needs VPN, runs as `dev` |
| `yarn inspect` | MCP Inspector |

Layout:

```
src/
  cli.ts              entry: serve | init | doctor | install
  server.ts           McpServer: registers kz_* + bo_* + pg_* tools, applies role, syncs skills, status → stderr
  role.ts             role gate, kz_guide / kz_set_role, guide text, show / hide dev-only tools
  core/               shared, no MCP or DB code
    constants.ts      package name, tool names, timeouts, row limits, annotation presets
    env.ts            every env var: key, default, comment, secret. Feeds config, init, doctor
    config.ts         loads .env files, typed accessors (role, bo, pg, ssh, skills), ConfigError
    store.ts          save one key to ~/.config/kz-pgw/.env (kz_set_role)
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
    reads.ts          BO API reads: methods, orders, members (no DB)
    tools.ts          bo_* tools
  pg/                 staging Postgres, read-only
    db.ts             pools, read-only tx, catalog queries
    guard.ts          SQL allow-list
    tunnel.ts         SSH jump host
    errors.ts         error → one actionable line, VPN nudge
    tools.ts          pg_* tools
  skills/sync.ts      copies skills/ → KZ_SKILLS_DIR
skills/               bundled Claude skills (kz-guide, kz-create-orders, kz-pgw-uat)
manifest.json         .mcpb user_config form for Claude Desktop
```

Add an env var: `src/core/env.ts` → accessor in `config.ts`. `init` and `doctor` pick it up. Update `manifest.json` and `.env.example` by hand.

Add a tool: name in `TOOLS` (`constants.ts`) → register in `bo/tools.ts` or `pg/tools.ts` → dev only? add it to `DEV_ONLY_TOOLS` → add it to the `want` list in `scripts/smoke.mjs`, `manifest.json` and this README.

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

- **Roles:** `project` never gets DB tools; its writes rely on kz-api's own 403 check.
- **DB login (dev):** `PGUSER` is your own existing staging login. Devs may have write access; QA use their read-only account. Either way the MCP itself is read-only: SQL keyword guard + `BEGIN READ ONLY` + 30 s timeout.
- **Prompt injection:** DB rows and webhooks can carry text aimed at Claude. Limits: non-GET `bo_api` only reaches deposit / withdraw; write tools are marked destructive. Never set `bo_create_*` or `bo_api` to "always allow" in Claude permissions, so you see every write before it runs.
- **Who can write:** nobody writes the DB through this MCP. Deposits / withdrawals go through the BO API as your own staff account (password + TOTP). Before sending, `bo_create_deposit` / `bo_create_withdraw` read your privileges from `kz-<group>` (`entityHasPrivilege`, same source kz-api uses) and stop if you lack `account:deposit-creator` / `account:withdrawal-creator`. kz-api checks again on the server.
- `bo_create_deposit` / `bo_create_withdraw` create real staging transactions. Keep `KZ_PGW_ALLOW_WRITES` off unless you need it that day.
- Private package (GitHub Packages, `access: restricted`). Credentials stay on your machine: `~/.config/kz-pgw/.env` (600) or the OS keychain via `.mcpb`.

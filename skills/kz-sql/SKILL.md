---
name: kz-sql
description: Read-only SQL on KZ staging Postgres through the kz-pgw MCP (pg_query, pg_list_tables, pg_describe_table). Use whenever the user wants data from a staging DB — "query", "SQL", "check tx", "find order TPG1X…", "status timeline", "why is deposit stuck", "member balance", "wallet tx", "webhook arrived?", "count deposits by status" — on groups like tpg1, ttg1, tig1, tco, tpk1, tph1, tth1. Also use when another skill (kz-bo-pgw, kz-pgw-issue) needs to write or run SQL against the group DB (kz-tpg1 etc.). Holds the real schema, enum values, joins and query templates, so use it before guessing column names.
---

# SQL — KZ staging read-only queries

Answer data questions from KZ staging Postgres. Read only. Fast, exact, short.

## Tools
`kz-pgw` MCP: `pg_query`, `pg_list_tables`, `pg_describe_table`, `pg_list_databases`.
Deferred? Load first with tool_search: `kz-pgw pg_query`.
MCP missing or "not configured" → tell user: run `npx -y @valoquang/kz-pgw-mcp doctor`, restart Claude Desktop.
Tool call times out → check Claude Desktop for a pending approval prompt, retry once.

## Workflow
1. **Pick DB.** Group → `kz-<group>`. Default `kz-tpg1`. Map in `references/schema.md`.
2. **Find the template.** Check `references/queries.md` first. Adapt it; don't write from zero.
3. **Unknown table/column?** `pg_describe_table` before writing. Never invent a column.
4. **Run.** One statement per `pg_query`. `max_rows` ≤ 50 unless user asks for more.
5. **Reply.** Answer first (one line), then the rows, then the SQL in a code block.

## Rules
- Identifiers are camelCase → always double-quote: `"fundingTx"`, `"createdAt"`, `"memberId"`.
- Reserved-word tables need quotes too: `"group"`.
- Every query on a big table needs a filter on id, `"orderRef"`, `"memberId"` or `"createdAt"`. Big tables: `activityLog`, `gameTx*`, `walletTx*`, `gameRoundRecord*`, `incidentReport`.
- `kz-tph1` (≈81 GB) and `kz-tth1` (≈417 GB): always add a `"createdAt"` window ≤ 7 days. No `count(*)` without a filter.
- Partitioned tables (`gameTx`, `walletTx`, `memberHourlyGameStats`): query the parent table with a `"createdAt"`/`"timestamp"` filter. Don't query `_pYYYYMMDD` children directly.
- Exclude soft-deleted rows: `"deletedAt" IS NULL`, unless the user asks for deleted.
- Times are `timestamptz`. Show UTC. Add `AT TIME ZONE 'Asia/Bangkok'` only if the user asks for local time.
- Money columns are `numeric`, returned as strings. Don't round.
- Never print secrets. Skip or mask: `credential.secret`, `fundingProvider.config`, `activityLog.value` keys containing `secret`, `password`, `token`, `revealedOTP`.
- PII (email, phone, `accNo`, `bankAccNo`): show only if the user asks for that member.
- No writes. The MCP blocks them; don't try. Data changes → `kz-bo-pgw` skill (bo_* tools) or BO.

## Key facts (full detail in references/schema.md)
- `fundingTx` = deposit/withdraw record. Find by `id`, `"orderRef"` (e.g. `TPG1XFW…`) or `"providerRef"`.
- Status timeline lives in `activityLog`: `"ownerId"` = `fundingTx.id`, `code` = `'created fundingTx'` / `'updated fundingTx'`, `value` = `{"field": [old, new]}`.
- Webhooks: `fundingNotification`, join on `"fundingTxId"` or `"orderRef"`.
- Balance: `wallet` (`type` = `default` | `secret`). Ledger: `walletTx`.

## Output
1. One-line answer.
2. Rows: table if more than 3, else inline.
3. The SQL you ran, in a `sql` code block.

Empty result → say "0 rows" and the one most likely reason (wrong group, wrong ref, time window).

---
name: "kz-pgw-issue"
description: "Analyze PGW payment issues raised by techOps. Traces status timeline in activityLog first (spot skipped audit, loops, timing gaps), correlates with webhooks and provider responses. Use for stuck deposits/withdrawals, early settlements, duplicate payments, timeouts, or any payment provider problems. Generates SQL queries, identifies root cause, suggests simple client-friendly actions, and drafts Slack messages."
---

# PGW Issue Analyzer

Use this skill to quickly diagnose payment provider (PGW) problems affecting deposits, withdrawals, or transfers.

## When to use

- A player reports a deposit is "stuck" or "failed"
- A withdrawal didn't reach the provider
- A provider says they never got a payment request
- Deposits from a specific bank/provider are timing out
- You see duplicate settlements or amount mismatches
- Transaction completed without the expected audit step
- Need to explain what happened to a client in simple terms

## What it does

1. **Takes** your issue description (e.g., "Player can't withdraw via Bank A since 2pm")
2. **Traces the status journey** using activityLog (tells the story: pending → processing → error → completed)
3. **Checks for anomalies**: Skipped steps? Loops? Unexpected jumps?
4. **Correlates with webhooks** and provider responses
5. **Identifies** root cause (provider delay, missing webhook, missing timeout, early settlement, status skip, etc.)
6. **Outputs**:
   - **Root Cause** — what actually happened in plain language
   - **Actions** — step-by-step what techOps can tell the client
   - **SQL queries** — to verify the diagnosis
   - **Slack draft** — ready to post to team

## How to use

Call with:

```
Analyze this PGW issue:
- Description: [what the player/client reported]
- Player ID or Transaction ID: [if available]
- Time window: [when it happened, e.g., "2pm-3pm UTC today"]
- Provider/Method: [bank name, e-wallet, or "all"]
- Brand: [which site, e.g., thkzg1]
```

Example:

```
Analyze this PGW issue:
- Description: Player tried to withdraw 500 THB via Bank A, got "pending" status, never completed
- Transaction ID: fx_12345
- Time window: 2026-09-27 14:00-15:00 UTC
- Provider: Bank A
- Brand: thkzg1
```

## Output format

### Root Cause
A 1-2 sentence explanation of what happened. Example:
- "Webhook from Bank A never arrived; transaction is waiting for confirmation that never came."
- "Our system sent the withdrawal but Bank A's API timed out and never responded."
- "Transaction went processing → completed without verification. Provider settled before KZ asked for proof."

### Actions
Simple steps for techOps to communicate to client. No jargon. Example:
- "Tell player: We sent their withdrawal to the bank. It's processing and may take 1-2 hours. If not received by tomorrow, contact support."
- "Tell player: Their deposit was delayed by the bank. We received it and added it to their balance. No action needed."
- "Escalate to Bank A support: We have a timeout on orders since 2pm. Need their system status."

### SQL Verification
Ready-to-run queries to double-check the diagnosis. Focus on:
- Status timeline (oldest → newest)
- Whether steps were skipped or looped
- Whether webhook was received
- Timing: when did each step happen relative to provider response?
- Provider's response data

### Slack Draft
A message template for posting to kz-ops-support or relevant channel, tagged with relevant people (@sect-bravo, @Minh, @Andy, @Quang).

---

## How it works: The diagnosis workflow

**The status timeline tells you everything. Always read it first (oldest → newest).**

1. **activityLog first** — Traces the complete status journey
   - Example: pending (14:00) → processing (14:01) → error (14:10) → processing (14:15) → pending-audit (14:20) → completed (14:30)
   - Read this as: Created, sent to provider, failed at 14:10 (investigate why!), retried, waited for audit, completed
   - **Look for anomalies:** Skipped steps? Loops? Unexpected jumps?
   - Example: `auditType = 'manual-audit'` but `auditApprovedAt` is null and status is completed = audit step skipped
   
2. **Correlate with fundingTx** — Current state + rejectReason/remark + payData
   - What does the system show now?
   - What error was recorded when it failed? (`"rejectReason"`, `remark`)
   - What did provider send back? (`"payData"`)
   
3. **fundingNotification check** — Did webhooks arrive when expected?
   - If activityLog shows `processing → error` at 14:10 but no notification for that time, provider callback failed
   - Notification `status = 'error'` → read `remark` for why it was rejected
   - Notification with null `"fundingTxId"` → match on `"orderRef"`; webhook did not link to the tx
   - If notification arrived <2 mins after tx creation and tx went straight to completed = Provider settled early
   - If multiple processed notifications for same tx, duplicate processing
   
4. **Pattern Matching** — Maps the timeline to root causes:
   - Timeline loops or stalls → Retry/manual intervention. When? By whom?
   - Status stuck in processing → No webhook arrived. Provider never called back.
   - Status stuck in pending-audit → Waiting for audit (auto or manual). Check `"auditType"`, `"auditorId"`.
   - Status timeout → Provider never confirmed within the window. Check fundingNotification for a late webhook.
   - Status: error then recovered → Fix was applied. What was the issue?
   - Duplicate charge → Check if webhook came twice.
   - Amount mismatch → Compare `"reqAmount"` vs `"netAmount"` vs amount in `payData` / notification `payload`.
   
5. **Output** — Root cause, actions, SQL, Slack

---

## Code reference (read before writing SQL or naming a cause)

`kz-api/docs/conventions/03-module-flow-map.md`:
- §3.3 Provider callback — 8 steps, which step each symptom points to (no callback / callback but tx unchanged / double credit).
- §3.1 Deposit, §3.2 Withdraw — status transitions, where wallet is debited/credited, what cron touches the tx.
- §5 Symptom → first file. Use the row before guessing.
- Provider adapter: `src/app/pgw/<provider>-<region>/provider.ts`. `ls src/app/pgw | grep -i <provider>` first.

SQL: follow the `sql` skill — real schema in its `references/schema.md`, templates in `references/queries.md`. Read it before writing any query. Table and column names are camelCase and double-quoted (`"fundingTx"`, `"fundingNotification"`, `"activityLog"`). Do not invent a column.

## Key tables

Verified on kz-tpg1 and kz-ttg1, 2026-10-12. Full list in the `sql` skill.

- **fundingTx**: The transaction record. Columns: `id`, `memberId`, `orderRef` (our order ID), `providerRef` (their order ID), `providerKey`, `method`, `type` (deposit/withdraw/promotion/turnover/adjustment/credit-loss/transfer), `status` (pending/processing/pending-audit/completed/error/timeout/cancelled), `reqAmount`, `netAmount`, `payData` (provider data, jsonb), `rejectReason`, `remark`, `auditType` (auto-audit/manual-audit/no-audit), `auditApprovedAt`, `providerNotifiedAt`, `createdAt`, `completedAt`, `cancelledAt`, `walletTxId`
- **fundingNotification**: Webhook from the provider. Columns: `id`, `fundingTxId` (can be null), `orderRef`, `providerKey`, `status` (new/processed/error), `payload` (jsonb), `attempts`, `remark` (why it failed), `processedAt`, `createdAt`
- **activityLog**: Change log for every model. Columns: `id`, `ownerId` (= fundingTx.id), `code` (`'created fundingTx'` / `'updated fundingTx'`), `category` (create/update/destroy/event/view), `value` (jsonb diff `{"field": [old, new]}`), `actorId` (null = system), `createdAt`
- There is no `pending-proof` status. Proof requirement is `fundingMethod."proofRequired"`.

---

## Common root causes

| Symptom | Root Cause | Actions |
| --- | --- | --- |
| Tx stuck in "processing" | Webhook never arrived; provider didn't call back | Check provider dashboard. May retry automatically. If stuck >2 hours, escalate to provider. |
| Completed but audit skipped (`manual-audit`, no `auditApprovedAt`) | Notification arrived before audit, or audit bypassed | Check notification time vs tx creation and the activityLog actor. If <2 mins apart, provider settled early. Else escalate to dev. |
| Proof upload stuck (method has `proofRequired`) | Missing fetch timeout on upload call (code bug) OR provider upload endpoint slow | Check provider code for `AbortSignal.timeout`. If missing, escalate to dev team. If present, provider is slow — wait or retry. |
| Tx shows "error" with reason | Provider rejected it (account blocked, insufficient balance, invalid bank, etc.) | Show error to player. Fix the issue (add funds, unblock account, etc.) then retry. |
| Withdraw created but never sent to provider | System error or timeout before sending | Retry the withdrawal. Check error logs. |
| Deposit completed but player balance didn't update | System bug or race condition | Manually verify balance and correct if needed. |
| Duplicate charge | Webhook processed twice OR provider settled twice | Check fundingNotification for >1 processed row per tx. Reverse if necessary. |
| Amount mismatch | Conversion error, fee not accounted for, or provider sent wrong amount | Verify what provider says. Adjust balance if needed. |

---

## Before you run this skill

- Have the kz-pgw MCP (pg_query) working. The skill will NOT modify data, only read.
- If issuing to Slack: make sure you have permission to post to kz-ops-support or your ops channel.
- Know the transaction ID or player ID. If not, provide time window + provider name and we'll search.
- **Start by asking the skill to run the activityLog query first.** It tells the whole story and any anomalies.

---

## Output example

```
## Root Cause
Deposit TPG1XFD26092700000123 went processing (14:01) → completed (14:02).
auditType = manual-audit but auditApprovedAt is null — audit was skipped.
Webhook arrived 14:01:30, 90 seconds after creation. Provider settled immediately.

## Actions
1. Tell player: "Your deposit was confirmed and added to your balance."
2. Escalate to dev: completed without audit approval on a manual-audit method.
3. If repeated on this provider: check provider flow with dev team.

## SQL to verify
[Query 1: Status timeline]
SELECT "createdAt", code,
       value->'status'->>0 AS "from", value->'status'->>1 AS "to", "actorId"
FROM "activityLog"
WHERE "ownerId" = '<fundingTx.id>'
  AND code IN ('created fundingTx', 'updated fundingTx')
ORDER BY "createdAt";

[Query 2: Webhook timing]
SELECT ft."createdAt" AS tx_created,
       min(fn."createdAt") AS first_webhook,
       round(extract(epoch FROM min(fn."createdAt") - ft."createdAt") / 60, 1) AS minutes
FROM "fundingTx" ft
LEFT JOIN "fundingNotification" fn ON fn."fundingTxId" = ft.id OR fn."orderRef" = ft."orderRef"
WHERE ft."orderRef" = 'TPG1XFD26092700000123'
GROUP BY ft."createdAt";

## Slack draft
[For #kz-ops-support]
:bell: **Deposit completed without audit**
Order TPG1XFD26092700000123 | Player P-1234 | 1000 THB
Timeline: processing (14:01) → webhook (14:01:30) → completed (14:02)
auditType manual-audit, no approval recorded.
Action: dev to check why audit was skipped.
@sect-bravo @Minh
```

---

## Tips

- **Status timeline is everything.** Read it oldest → newest. It tells the story.
- **Look for skipped steps.** A manual-audit tx should pass pending-audit and have `auditApprovedAt` before completed. If not, investigate.
- **Time window matters.** Even 1 hour helps narrow down which tx we're looking at.
- **Provider name helps.** If you say "Bank A" vs just "withdraw failed", we can spot patterns (e.g., all Bank A withdrawals failing).
- **Look for loops or jumps.** If status changes erratically (pending → processing → pending → completed), that's an indicator of manual intervention or retries.
- **Check notification timing.** If notification arrived <2 mins after tx creation, provider might be settling early. If notification is slow, that's the delay.
- **Check the provider's status page first** if you suspect their issue, not ours. This skill will help confirm.
- **Duplicate issues?** If many players hit the same problem at the same time, it's usually the provider, not a bug.
- **Timeout issues:** One provider stuck while others work = provider issue. Many proofs stuck + no AbortSignal in code = code bug, needs dev fix.

---

## One-time setup: Learn from history

The first time you use this skill (or to refresh), ask to bootstrap:

```
kz-pgw-issue bootstrap
```

This will:
1. Search kz-ops-support Slack for past PGW issues (last 90 days)
2. Extract patterns: which providers fail most, what errors are common, how we fixed them
3. Tag @sect-bravo, @Minh, @Andy, @Quang for context
4. Save a reference file for the skill to use in future diagnostics

This makes the skill smarter over time. Do this once per quarter.

---

## What NOT to use this skill for

- **Live player support.** This is for techOps/ops, not to send directly to players.
- **Modifying transactions.** This skill only diagnoses. For reversals, adjustments, or manual overrides, use BO tools.
- **Provider API calls.** This skill doesn't call the provider. You need to check their dashboard separately.
- **General payment debugging.** If it's not a PGW issue (e.g., internal wallet bug), use another tool.
- **Opening code PRs.** This skill diagnoses and surfaces issues. Code fixes (like adding AbortSignal) require dev team sign-off.


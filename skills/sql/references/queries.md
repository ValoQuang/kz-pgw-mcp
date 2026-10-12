# Query templates

Replace `:orderRef`, `:txId`, `:memberId`, `:apiIdentifier` with real values (single-quoted). Default DB `kz-tpg1`.

## 1. Find a tx by any ref
```sql
SELECT id, "orderRef", "providerRef", type, status, "reqAmount", "reqCurrency", "netAmount",
       method, "providerKey", "auditType", "rejectReason", remark,
       "createdAt", "providerNotifiedAt", "completedAt", "cancelledAt"
FROM "fundingTx"
WHERE "orderRef" = :orderRef OR "providerRef" = :orderRef OR id::text = :orderRef
LIMIT 5;
```

## 2. Status timeline of one tx (read this first for any "stuck" question)
```sql
SELECT "createdAt", code,
       value->'status'->>0 AS "from",
       value->'status'->>1 AS "to",
       "actorId",
       value - 'updatedAt' AS changes
FROM "activityLog"
WHERE "ownerId" = :txId
  AND code IN ('created fundingTx', 'updated fundingTx')
ORDER BY "createdAt";
```
`"actorId"` null = system. Status loop or jump = retry / manual change.

## 3. Webhooks for one tx
```sql
SELECT "createdAt", status, attempts, "processedAt", remark, "fundingTxId", "orderRef",
       left(payload::text, 300) AS payload
FROM "fundingNotification"
WHERE "fundingTxId" = :txId OR "orderRef" = :orderRef
ORDER BY "createdAt";
```
0 rows = provider never called back. `status = 'error'` → read `remark`.

## 4. Minutes from tx created to first webhook
```sql
SELECT ft."orderRef", ft."createdAt" AS tx_created,
       min(fn."createdAt") AS first_webhook,
       round(extract(epoch FROM min(fn."createdAt") - ft."createdAt") / 60, 1) AS minutes
FROM "fundingTx" ft
LEFT JOIN "fundingNotification" fn ON fn."fundingTxId" = ft.id
WHERE ft.id = :txId
GROUP BY ft."orderRef", ft."createdAt";
```

## 5. Stuck txs (processing / pending-audit longer than 30 min)
```sql
SELECT id, "orderRef", type, status, "providerKey", "reqAmount", "createdAt",
       round(extract(epoch FROM now() - "createdAt") / 60) AS age_min
FROM "fundingTx"
WHERE status IN ('pending', 'processing', 'pending-audit')
  AND "createdAt" < now() - interval '30 minutes'
  AND "createdAt" > now() - interval '7 days'
  AND "deletedAt" IS NULL
ORDER BY "createdAt"
LIMIT 50;
```

## 6. Count by status per provider (last 24 h)
```sql
SELECT "providerKey", type, status, count(*) AS n, sum("reqAmount") AS total
FROM "fundingTx"
WHERE "createdAt" > now() - interval '24 hours'
  AND "deletedAt" IS NULL
GROUP BY 1, 2, 3
ORDER BY 1, 2, n DESC;
```

## 7. Member lookup
```sql
SELECT m.id, m."apiIdentifier", m.status, m."registerAt", m."deposit1At",
       w.type AS wallet, w.balance
FROM member m
LEFT JOIN wallet w ON w."memberId" = m.id AND w."deletedAt" IS NULL
WHERE m."apiIdentifier" = :apiIdentifier OR m.id::text = :apiIdentifier;
```

## 8. Member recent funding
```sql
SELECT "createdAt", "orderRef", type, status, "reqAmount", method, "rejectReason"
FROM "fundingTx"
WHERE "memberId" = :memberId
  AND "createdAt" > now() - interval '30 days'
ORDER BY "createdAt" DESC
LIMIT 20;
```

## 9. Member wallet ledger
```sql
SELECT "createdAt", type, amount, balance, memo
FROM "walletTx"
WHERE "memberId" = :memberId
  AND "createdAt" > now() - interval '7 days'
ORDER BY "createdAt" DESC, "txIndex" DESC
LIMIT 50;
```

## 10. Did the completed tx credit the wallet?
```sql
SELECT ft."orderRef", ft.status, ft."netAmount", ft."walletTxId",
       wt.amount AS wallet_amount, wt.balance AS balance_after, wt."createdAt" AS credited_at
FROM "fundingTx" ft
LEFT JOIN "walletTx" wt ON wt.id = ft."walletTxId"
                       AND wt."createdAt" BETWEEN ft."createdAt" - interval '1 day' AND ft."createdAt" + interval '7 days'
WHERE ft.id = :txId;
```
Completed + `"walletTxId"` null = not credited.

## 11. Duplicate webhooks (same tx, more than one processed)
```sql
SELECT "fundingTxId", count(*) AS n, min("createdAt"), max("createdAt")
FROM "fundingNotification"
WHERE status = 'processed'
  AND "createdAt" > now() - interval '7 days'
GROUP BY 1
HAVING count(*) > 1
ORDER BY n DESC
LIMIT 50;
```

## 12. Member primary bank profile
```sql
SELECT id, type, key, "isPrimary", "createdAt"
FROM "fundingProfile"
WHERE "memberId" = :memberId AND "deletedAt" IS NULL
ORDER BY "isPrimary" DESC, "createdAt" DESC;
```
Add `"accNo"` only if the user asks.

## 13. Active methods for a provider (no secrets)
```sql
SELECT fm.key, fm.type, fm.name, fm.min, fm.max, fm.currency, fm.status, fm.disabled,
       fp.key AS provider, fp.status AS provider_status, fp.configured
FROM "fundingMethod" fm
JOIN "fundingProvider" fp ON fp.id = fm."fundingProviderId"
WHERE fp.key = :providerKey
  AND fm."deletedAt" IS NULL
ORDER BY fm.type, fm.sort;
```

## 14. Who changed a provider / method (no config values)
```sql
SELECT "createdAt", code, "actorId",
       (SELECT array_agg(k) FROM jsonb_object_keys(value) k) AS changed_fields
FROM "activityLog"
WHERE code IN ('updated fundingProvider', 'update fundingProvider', 'updated fundingMethod', 'update fundingMethod')
  AND "createdAt" > now() - interval '7 days'
ORDER BY "createdAt" DESC
LIMIT 30;
```
Lists field names only, never values, because `config.secret.*` is in `value`.

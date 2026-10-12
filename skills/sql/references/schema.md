# KZ staging schema (core tables)

Source: `information_schema` on `kz-tpg1`, 2026-10-12. Other groups share the same migrations, but verify with `pg_describe_table` if a column is missing.

## Databases
| Group | DB | Size | Note |
|---|---|---|---|
| tpg1 | kz-tpg1 | ~1 GB | default |
| ttg1 | kz-ttg1 | ~2 GB | |
| tig1 | kz-tig1 | ~0.8 GB | |
| tco | kz-tco | ~0.2 GB | |
| tgg | kz-tgg | small | |
| tpe | kz-tpe | small | |
| tbd1 | kz-tbd1 | ~3 GB | |
| tpk1 | kz-tpk1 | ~6 GB | |
| tph1 | kz-tph1 | ~81 GB | time filter ≤ 7 days |
| tth1 | kz-tth1 | ~417 GB | time filter ≤ 7 days |
| — | kz-api | ~0.9 GB | global/shared, not a group |

Not for queries: `kz-gameboy`, `kz_monitoring`, `postgres`, `rdsadmin`.

## Relations
```
member ──< wallet ──< walletTx
   │                    ▲
   ├──< fundingTx ──────┘ ("walletTxId")
   │       ├──< fundingNotification ("fundingTxId" / "orderRef")
   │       └──< activityLog ("ownerId" = fundingTx.id)
   ├──< fundingProfile
   └──< memberGroup >── "group"

fundingTx."providerKey" = fundingProvider.key
fundingTx.method        = fundingMethod.key   (e.g. 'tpay-th/bank-transfer')
fundingMethod."fundingProviderId" → fundingProvider.id
```

## fundingTx
`id` uuid · `createdAt` · `updatedAt` · `deletedAt` · `accountId` · `memberId` · `creatorId` · `walletTxId` · `orderRef` · `type` · `reqAmount` · `reqCurrency` · `netAmount` · `netCurrency` · `remark` · `status` · `providerKey` · `providerRef` · `payData` jsonb · `requestedAt` · `providerNotifiedAt` · `auditApprovedAt` · `completedAt` · `cancelledAt` · `method` · `auditorId` · `processorId` · `auditType` · `rejectReason` · `orderCreatedAt` · `receivedAt` · `memo` · `paymentMethod` · `originOrderRef` · `walletType`

- `status`: `pending`, `processing`, `pending-audit`, `completed`, `error`, `timeout`, `cancelled`
- `type`: `deposit`, `withdraw`, `promotion`, `turnover`, `adjustment`, `credit-loss`, `transfer`
- `auditType`: `auto-audit`, `manual-audit`, `no-audit`, null
- `walletType`: `default`, `secret`
- Error text: `"rejectReason"` and `remark`. There is no `errorReason` column.
- Provider data: `"payData"` (jsonb). There is no `providerResponse` column.

## fundingNotification (provider webhooks)
`id` · `createdAt` · `updatedAt` · `deletedAt` · `providerKey` · `status` · `payload` jsonb · `attempts` · `lastAttemptAt` · `processedAt` · `remark` · `fundingTxId` · `orderRef` · `ipAddress`

- `status`: `new` → `processed` | `error`
- `"fundingTxId"` can be null if the webhook didn't match a tx → also match on `"orderRef"`.
- Why it failed: `remark`.

## activityLog (audit trail for every model)
`id` · `createdAt` · `updatedAt` · `deletedAt` · `memberId` · `code` · `description` · `category` · `ownerId` · `ownerName` · `actorId` · `ipAddress` · `value` jsonb · `accountId` · `extras` jsonb

- `"ownerId"` = id of the changed row. For a tx: `fundingTx.id`.
- `code` = `'<verb> <model>'`, e.g. `created fundingTx`, `updated fundingTx`, `updated fundingNotification`, `updated fundingProvider`, `created member`, `game login`.
- `category`: `create`, `update`, `destroy`, `event`, `view`
- `value` = diff: `{"<field>": [old, new]}`. Status change: `value->'status'->>0` (from), `value->'status'->>1` (to).
- `"actorId"` = who did it (null = system/cron/webhook).
- Large table. Always filter on `"ownerId"`, `"memberId"` or `"createdAt"`.

## member
Key columns: `id` · `accountId` · `apiIdentifier` (username) · `status` · `firstname` · `lastname` · `fullname` · `email` · `phone` · `bankKey` · `bankAccNo` · `registerAt` · `deposit1At` · `deposit2At` · `deposit3At` · `referrerId` · `referralCode` · `info` jsonb · `createdAt` · `deletedAt`
- `status`: `active` (others may exist on other groups)

## wallet
`id` · `accountId` · `memberId` · `type` · `txCount` · `balance` · timestamps
- `type`: `default` (main), `secret`

## walletTx (partitioned)
`id` · `accountId` · `memberId` · `walletId` · `txIndex` · `timestamp` · `type` · `memo` · `remark` · `amount` · `balance` (after) · timestamps
- Always filter `"memberId"` + `"createdAt"` window.
- Old rows: `walletTx_legacy`, `walletTxArchive`.

## fundingProfile (member bank / e-wallet accounts)
`id` · `accountId` · `memberId` · `type` · `key` (bank code, e.g. `BBL`) · `accNo` · `info` jsonb · `isPrimary` · `description` · timestamps
- `type`: `bank`, `e-wallet`

## fundingMethod
`id` · `fundingProviderId` · `type` · `key` · `method` · `name` · `min` · `max` · `currency` · `status` · `disabled` · `proofRequired` · `fundingProfileRequired` · `fundingProfileType` · `isPassive` · `fundingGroupId` · `sort` · `internalName` · timestamps

## fundingProvider
`id` · `accountId` · `key` · `name` · `status` · `config` jsonb (**secrets — never select**) · `configured` · `balance` · `lastSyncedAt` · `sortPriority` · timestamps

## memberGroup / "group"
`memberGroup`: `groupId` · `memberId`. `"group"` must be quoted.

## Views worth knowing
`extFundingTx`, `extMember`, `evtFirstDeposit`, `evtSecondDeposit`, `providerStats`, `categoryStats`. Describe before use.

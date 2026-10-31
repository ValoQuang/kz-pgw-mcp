# PGW UAT SOP: 6 cases

Source: SOP OS-52 "Payment Gateway Integration Guide" → UAT Test Cases.
KZ (dev + PA) and the client must both pass all 6 before the PR is merged to staging.
UAT groups today: `tpg1`, `ttg1`, `tig1`.

## Before UAT (dev)
- Provider + methods created on the group (`create-payment-controls`). Banks / e-wallets only if new (`upsert-bank-list`, `upsert-ewallet-config`).
- BO → Integration settings (group level): provider shows, every field filled.
- Dev made one deposit in MP and it reached the provider page. Do not hand off before this.
- PA reviewed the cases below with dev.

## The 6 cases

Each case can be run in the Member Portal (MP) as a player, or in BO by staff creating the order for a member. Both count.

| # | Case | How to run | Pass when |
|---|---|---|---|
| C1 | Deposit success | MP → Top up → pick provider → pay the full amount on the provider page | Order `completed` after the provider callback. Balance + amount. Order is in BO Deposit tab |
| C2 | Deposit rejected | MP → Top up → reject / fail the payment on the provider side. Ask the provider first if they support it; no → N/A | Order `error` after the provider callback. Balance unchanged |
| C3 | Withdraw success | MP → Withdraw to a bank / e-wallet the provider supports → provider approves | Order `completed` after the provider callback. Balance − amount |
| C4 | Withdraw rejected | MP → Withdraw → provider accepts (trade id returned) → provider fails it on their side → reject callback | Order pending-audit after the callback (not error). Balance held, not lost |
| C5 | Paid ≠ entered amount | MP → enter 100 → pay 50 on the provider page (ask the provider first if they allow it; no → N/A) | Credited = amount really paid (`netAmount`), never the entered amount. Paid more than entered → tell dev now |
| C6 | 3rd balance | BO → Integration settings → Sync → read provider balance | Same as the balance in the provider's own BO |

C4 steps:
1. MP → Withdraw → submit, or BO → create a withdraw for the member.
2. We send it to the provider; the order is `processing` and the balance is reduced.
3. The provider accepts and returns a trade id (`providerRef`). No trade id → C4 not met.
4. The provider fails the order in its own back office and sends the reject callback.
5. Expected in BO: the order is `pending-audit`, not `error`; the callback time is set; the balance is held, not lost.

Also for every case:
- Order processed within 2 min of the callback. Slower → kz-event-processor not redeployed or stuck.
- Provider can reject both a deposit and a withdraw.
- Currency factor: amount in KZ BO = amount in provider BO (no cents / ×100 mix-up).
- Test the deposit page on Chrome and Safari iOS.

## Extra cases (add when they apply)
| When | Case |
|---|---|
| `creditReqAmount` on | Pay less than entered (within 1 unit) → credit stays inside tolerance |
| MX | Reused CLABE: second payment to the same CLABE does not credit twice |
| New region | Payment page in iframe vs new tab works |
| PH, TH | Special characters in member name |
| Google-login region | Member with no phone → dummy phone fallback |
| Payload has time fields | Order not rejected for timezone |
| Provider sends Expired | Maps to `timeout` |

## How to verify
- Whole UAT: "verify UAT for `<provider>` on `<group>` since `<date>`" → PASS / PENDING / FAIL per case (`kz-verify-orders` skill).
- One order: ask "check tx `<orderRef>` on `<group>`" (status, callback, wallet credit).
- Stuck or wrong order: ask "analyze `<orderRef>` on `<group>`".

## After UAT
- PASS → request PR approval → project lead merges to staging.
- Deploy: tell DevOps the scripts to run and to redeploy kz-event-processor.

/**
 * Backoffice-API reads. No DB: works for both roles (project uses only these).
 * kz-api list endpoints answer { result: { entries, meta } } and take cruder filters:
 *   col=a,b (IN) · col=-a (NOT) · date=from,to · nolimit=true · sort=col:dir
 * Sources: kz-api routes/api/account/funding/{tx,method,profile}, account/member/:id/balance.
 */

import { ORDER_LIMITS } from "../core/constants.js";
import { apiCall } from "./api.js";

type Json = Record<string, unknown>;

export function entriesOf<T = Json>(res: unknown): T[] {
  const r = res as { result?: { entries?: unknown }; entries?: unknown };
  const e = r?.result?.entries ?? r?.entries;
  return Array.isArray(e) ? (e as T[]) : [];
}

const qs = (q: Record<string, string | number | undefined>): string =>
  Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

// ---------- funding methods / providers ----------

export interface MethodRow {
  key: string;
  providerKey: string;
  type: string;
  name: string;
  internalName: string;
  status: string;
  returnType?: string;
  min?: string;
  max?: string;
  currency?: string;
}

export async function listMethods(group: string): Promise<MethodRow[]> {
  const res = await apiCall(group, "GET", `/account/funding/method/list?${qs({ nolimit: "true" })}`);
  return entriesOf(res)
    .filter((m) => typeof m.key === "string")
    .map((m) => ({
      key: m.key as string,
      providerKey: (m.key as string).split("/")[0],
      type: String(m.type ?? ""),
      name: String(m.name ?? ""),
      internalName: String(m.internalName ?? ""),
      status: String(m.status ?? ""),
      returnType: m.returnType as string | undefined,
      min: m.min as string | undefined,
      max: m.max as string | undefined,
      currency: m.currency as string | undefined,
    }));
}

const norm = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");

/** Provider key or name → matching provider keys. Exact key wins; else key prefix / name / internalName contains. */
export function matchProviders(methods: MethodRow[], provider: string): { keys: string[]; methods: MethodRow[] } {
  const want = provider.trim().toLowerCase();
  const exact = methods.filter((m) => m.providerKey.toLowerCase() === want || m.key.toLowerCase() === want);
  const hits = exact.length
    ? exact
    : methods.filter(
        (m) =>
          norm(m.providerKey).includes(norm(want)) || norm(m.name).includes(norm(want)) || norm(m.internalName).includes(norm(want)),
      );
  const keys = [...new Set(hits.map((m) => m.providerKey))].sort();
  return { keys, methods: methods.filter((m) => keys.includes(m.providerKey)) };
}

// ---------- orders (fundingTx) ----------

export interface OrderRow {
  id: string;
  orderRef: string | null;
  type: string;
  status: string;
  auditType: string | null;
  providerKey: string | null;
  method: string | null;
  reqAmount: string | null;
  netAmount: string | null;
  currency: string | null;
  /** null = created by the player in MP. Set = created by staff in BO. */
  creatorId: string | null;
  memberId: string | null;
  providerRef: string | null;
  requestedAt: string | null;
  providerNotifiedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  /** Seconds from provider callback to completed/cancelled. */
  callbackToDoneSec: number | null;
  rejectReason: string | null;
  error: string | null;
}

const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
const secs = (a: string | null, b: string | null): number | null =>
  a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : null;

function toOrder(t: Json): OrderRow {
  const pay = (t.payData ?? {}) as Json;
  const providerNotifiedAt = str(t.providerNotifiedAt);
  const doneAt = str(t.completedAt) ?? str(t.cancelledAt);
  return {
    id: String(t.id),
    orderRef: str(t.orderRef),
    type: String(t.type),
    status: String(t.status),
    auditType: str(t.auditType),
    providerKey: str(t.providerKey),
    method: str(t.method),
    reqAmount: str(t.reqAmount),
    netAmount: str(t.netAmount),
    currency: str(t.reqCurrency) ?? str(t.netCurrency),
    creatorId: str(t.creatorId),
    memberId: str(t.memberId),
    providerRef: str(t.providerRef),
    requestedAt: str(t.requestedAt),
    providerNotifiedAt,
    completedAt: str(t.completedAt),
    cancelledAt: str(t.cancelledAt),
    callbackToDoneSec: secs(providerNotifiedAt, doneAt),
    rejectReason: str(t.rejectReason),
    error: str(pay.error),
  };
}

export interface OrderQuery {
  providerKeys?: string[];
  types: string[];
  /** No since → no requestedAt filter, newest first. */
  since?: string;
  until?: string;
  status?: string;
  /** Exact, comma list allowed. */
  orderRef?: string;
  memberId?: string;
  limit: number;
}

export async function listOrders(group: string, q: OrderQuery): Promise<{ orders: OrderRow[]; total: number | null }> {
  const res = await apiCall(
    group,
    "GET",
    `/account/funding/tx/list?${qs({
      providerKey: q.providerKeys?.join(","),
      type: q.types.join(","),
      requestedAt: q.since ? `${q.since},${q.until ?? new Date().toISOString()}` : undefined,
      status: q.status,
      orderRef: q.orderRef,
      // FundingTx filter reads memberId from query key "member" (models/funding/FundingTx.ts).
      member: q.memberId,
      limit: Math.min(q.limit, ORDER_LIMITS.max),
      sort: q.since ? "requestedAt:asc" : "requestedAt:desc",
    })}`,
  );
  const meta = (res as { result?: { meta?: { count?: number } } })?.result?.meta;
  return { orders: entriesOf(res).map(toOrder), total: typeof meta?.count === "number" ? meta.count : null };
}

/** Counts per type → status. */
export function summarize(orders: OrderRow[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const o of orders) {
    out[o.type] ??= {};
    out[o.type][o.status] = (out[o.type][o.status] ?? 0) + 1;
  }
  return out;
}

// ---------- members (project role: no DB) ----------

export interface ApiMemberRow {
  memberId: string;
  balance: string;
  fundingProfileId: string;
  profileType: string;
  bankKey: string;
  accNo: string;
  isPrimary: boolean;
}

/** Funding profiles via API, then wallet balance per member. Scans at most ORDER_LIMITS.memberScan members. */
export async function findMembersViaApi(
  group: string,
  opts: { minBalance: number; profileType?: string; limit: number },
): Promise<{ members: ApiMemberRow[]; scanned: number }> {
  const res = await apiCall(
    group,
    "GET",
    `/account/funding/profile/list?${qs({ type: opts.profileType, deletedAt: "null", limit: 200, sort: "createdAt:desc" })}`,
  );
  const byMember = new Map<string, Json[]>();
  for (const p of entriesOf(res)) {
    const id = str(p.memberId);
    if (!id || p.deletedAt) continue;
    if (!byMember.has(id)) byMember.set(id, []);
    byMember.get(id)!.push(p);
  }

  const members: ApiMemberRow[] = [];
  let scanned = 0;
  for (const [memberId, profiles] of byMember) {
    if (members.length >= opts.limit || scanned >= ORDER_LIMITS.memberScan) break;
    scanned++;
    const wallets = entriesOf(await apiCall(group, "GET", `/account/member/${memberId}/balance`));
    const def = wallets.find((w) => (w.type ?? "default") === "default") ?? wallets[0];
    const balance = Number(def?.balance ?? 0);
    if (!(balance > opts.minBalance)) continue;
    for (const p of profiles) {
      if (members.length >= opts.limit) break;
      members.push({
        memberId,
        balance: String(def?.balance ?? "0"),
        fundingProfileId: String(p.id),
        profileType: String(p.type ?? ""),
        bankKey: String(p.key ?? ""),
        accNo: String(p.accNo ?? ""),
        isPrimary: p.isPrimary === true,
      });
    }
  }
  members.sort((a, b) => Number(b.balance) - Number(a.balance));
  return { members, scanned };
}

import { apiBase, bo as cfg } from "../config.js";
import { totpCode, totpSecondsLeft } from "./totp.js";

interface TokenResponse {
  token_type: string;
  access_token: string;
  expires_at: number;
  expires_in: number;
  refresh_token: string;
  refresh_expires_at: number;
}

interface TotpCheck {
  result?: { accessKey?: string; totpEnabled?: boolean; hasTotp?: boolean };
}

interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix seconds
  refreshExpiresAt: number;
  totpDone: boolean;
}

const sessions = new Map<string, Session>();

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`${res.status} ${url} → ${JSON.stringify(data).slice(0, 500)}`);
  return data as T;
}

function store(group: string, t: TokenResponse, totpDone: boolean): Session {
  const s: Session = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: t.expires_at,
    refreshExpiresAt: t.refresh_expires_at,
    totpDone,
  };
  sessions.set(group, s);
  return s;
}

/**
 * Step 1+2: check TOTP, get pre-TOTP token.
 * If KZ_TOTP_SECRET_<GROUP> is set, also does step 3 automatically.
 */
export async function login(group: string): Promise<{ totpRequired: boolean; autoTotp: boolean; expiresAt?: number }> {
  const base = apiBase(group);
  const { username, password } = cfg.credentials();
  const common = { client_id: username, client_secret: password, entity_type: "person" };

  const check = await postJson<TotpCheck>(`${base}/oauth/totp`, common);
  const totpRequired = check.result?.totpEnabled === true;

  const pre = await postJson<TokenResponse>(`${base}/oauth/access_token`, { ...common, grant_type: "password" });
  store(group, pre, !totpRequired);
  if (!totpRequired) return { totpRequired: false, autoTotp: false, expiresAt: pre.expires_at };

  const secret = cfg.totpSecret(group);
  if (!secret) return { totpRequired: true, autoTotp: false };

  if (totpSecondsLeft() < 3) await new Promise((r) => setTimeout(r, 3500));
  const s = await submitTotp(group, totpCode(secret));
  return { totpRequired: false, autoTotp: true, expiresAt: s.expiresAt };
}

/** Step 3: exchange TOTP code for the real token. */
export async function submitTotp(group: string, totp: string): Promise<Session> {
  const { username, password } = cfg.credentials();
  const t = await postJson<TokenResponse>(`${apiBase(group)}/oauth/access_token`, {
    client_id: username,
    client_secret: password,
    entity_type: "person",
    grant_type: "totp",
    totp,
  });
  return store(group, t, true);
}

async function refresh(group: string, s: Session): Promise<Session> {
  const { username, password } = cfg.credentials();
  const t = await postJson<TokenResponse>(`${apiBase(group)}/oauth/access_token`, {
    client_id: username,
    client_secret: password,
    entity_type: "person",
    grant_type: "refresh_token",
    refresh_token: s.refreshToken,
  });
  return store(group, t, true);
}

export async function bearer(group: string): Promise<string> {
  const s = sessions.get(group);
  const now = Math.floor(Date.now() / 1000);
  if (!s || !s.totpDone) throw new Error(`Not logged in to ${group}. Call bo_login then bo_submit_totp.`);
  if (s.expiresAt - 60 > now) return s.accessToken;
  if (s.refreshExpiresAt - 60 > now) {
    try {
      return (await refresh(group, s)).accessToken;
    } catch (e) {
      sessions.delete(group);
      throw new Error(`Refresh failed for ${group}: ${(e as Error).message}. Re-run bo_login.`);
    }
  }
  sessions.delete(group);
  throw new Error(`Session for ${group} expired. Re-run bo_login.`);
}

export function status(): Array<{ group: string; totpDone: boolean; expiresAt: number; expiresInSec: number }> {
  const now = Math.floor(Date.now() / 1000);
  return [...sessions.entries()].map(([group, s]) => ({
    group,
    totpDone: s.totpDone,
    expiresAt: s.expiresAt,
    expiresInSec: s.expiresAt - now,
  }));
}

export function logout(group: string): boolean {
  return sessions.delete(group);
}

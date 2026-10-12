/**
 * Backoffice OAuth for staff ("person") accounts, one cached session per group.
 *   1. POST /oauth/totp               → is TOTP on?
 *   2. POST /oauth/access_token password → pre-TOTP token
 *   3. POST /oauth/access_token totp     → real token (auto if KZ_TOTP_SECRET_<GROUP> set)
 * Tokens refresh via grant_type=refresh_token.
 */

import { apiBase, bo as cfg } from "../core/config.js";
import { TIMEOUT_MS, TOOLS } from "../core/constants.js";
import { requestJson } from "./http.js";
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

/** Renew this many seconds before expiry. */
const EXPIRY_SKEW_S = 60;

const sessions = new Map<string, Session>();

const nowS = (): number => Math.floor(Date.now() / 1000);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** POST to /oauth/<path> with the staff credentials + extra fields. */
function oauth<T>(group: string, path: "totp" | "access_token", extra: Record<string, unknown> = {}): Promise<T> {
  const { username, password } = cfg.credentials();
  return requestJson<T>("POST", `${apiBase(group)}/oauth/${path}`, {
    body: { client_id: username, client_secret: password, entity_type: "person", ...extra },
    timeoutMs: TIMEOUT_MS.boAuth,
    errorChars: 500,
  });
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

/** Steps 1+2, plus step 3 when a TOTP secret is configured. */
export async function login(group: string): Promise<{ totpRequired: boolean; autoTotp: boolean; expiresAt?: number }> {
  const check = await oauth<TotpCheck>(group, "totp");
  const totpRequired = check.result?.totpEnabled === true;

  const pre = await oauth<TokenResponse>(group, "access_token", { grant_type: "password" });
  store(group, pre, !totpRequired);
  if (!totpRequired) return { totpRequired: false, autoTotp: false, expiresAt: pre.expires_at };

  const secret = cfg.totpSecret(group);
  if (!secret) return { totpRequired: true, autoTotp: false };

  // Code about to roll over → wait for the next window.
  if (totpSecondsLeft() < 3) await sleep(3500);
  const s = await submitTotp(group, totpCode(secret));
  return { totpRequired: false, autoTotp: true, expiresAt: s.expiresAt };
}

/** Step 3: exchange TOTP code for the real token. */
export async function submitTotp(group: string, totp: string): Promise<Session> {
  return store(group, await oauth<TokenResponse>(group, "access_token", { grant_type: "totp", totp }), true);
}

async function refresh(group: string, s: Session): Promise<Session> {
  const t = await oauth<TokenResponse>(group, "access_token", { grant_type: "refresh_token", refresh_token: s.refreshToken });
  return store(group, t, true);
}

export async function bearer(group: string): Promise<string> {
  const s = sessions.get(group);
  const now = nowS();
  if (!s || !s.totpDone) throw new Error(`Not logged in to ${group}. Call ${TOOLS.boLogin} then ${TOOLS.boSubmitTotp}.`);
  if (s.expiresAt - EXPIRY_SKEW_S > now) return s.accessToken;
  if (s.refreshExpiresAt - EXPIRY_SKEW_S > now) {
    try {
      return (await refresh(group, s)).accessToken;
    } catch (e) {
      sessions.delete(group);
      throw new Error(`Refresh failed for ${group}: ${(e as Error).message}. Re-run ${TOOLS.boLogin}.`);
    }
  }
  sessions.delete(group);
  throw new Error(`Session for ${group} expired. Re-run ${TOOLS.boLogin}.`);
}

export function status(): Array<{ group: string; totpDone: boolean; expiresAt: number; expiresInSec: number }> {
  const now = nowS();
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

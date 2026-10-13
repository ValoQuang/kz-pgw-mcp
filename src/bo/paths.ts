/** bo_api paths: normalise like fetch does, stay on the group host, allow-list non-GET. No config, no I/O. */

export const BO_PATH = {
  deposit: "/account/funding/tx/deposit",
  withdraw: "/account/funding/tx/withdraw",
} as const;

export type WriteKind = keyof typeof BO_PATH;

/** The only paths non-GET bo_api may call. Same privilege check as the dedicated tools. */
export const WRITE_PATHS: Readonly<Record<string, WriteKind>> = {
  [BO_PATH.deposit]: "deposit",
  [BO_PATH.withdraw]: "withdraw",
};

const BASE = "https://api.invalid";

/**
 * Resolve the path the way fetch will (dot segments, %2e, backslashes) so the
 * allow-list sees the real target. Throws if the result leaves the group host
 * (e.g. "//evil.com/x"). Trailing slashes are dropped.
 */
export function normalizePath(path: string): { pathname: string; search: string } {
  const u = new URL(path, BASE);
  if (u.origin !== BASE) throw new Error(`path must stay on the group API host, got "${path}"`);
  return { pathname: u.pathname.replace(/\/+$/, "") || "/", search: u.search };
}

/** Non-GET target → write kind, or null when not allowed. Only POST. */
export function writeTarget(method: string, pathname: string): WriteKind | null {
  return method === "POST" ? (WRITE_PATHS[pathname] ?? null) : null;
}

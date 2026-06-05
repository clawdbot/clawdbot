// Account lookup helpers resolve route accounts from normalized account ids.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// Case-insensitive account lookup for config maps that may preserve user
// casing. Exact keys win so callers can still distinguish intentional entries.
export function resolveAccountEntry<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
): T | undefined {
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  if (Object.hasOwn(accounts, accountId)) {
    return accounts[accountId];
  }
  const normalized = normalizeLowercaseStringOrEmpty(accountId);
  const matchKey = Object.keys(accounts).find(
    (key) => normalizeLowercaseStringOrEmpty(key) === normalized,
  );
  return matchKey ? accounts[matchKey] : undefined;
}

// Lookup variant for account ids with a channel-specific normalization rule.
// Used when config keys should match the same canonical id as routing state.
export function resolveNormalizedAccountEntry<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
  normalizeAccountId: (accountId: string) => string,
): T | undefined {
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  if (Object.hasOwn(accounts, accountId)) {
    return accounts[accountId];
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? accounts[matchKey] : undefined;
}

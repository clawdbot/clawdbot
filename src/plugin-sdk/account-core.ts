import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";

export {
  DEFAULT_ACCOUNT_ID,
  listCombinedAccountIds,
  listConfiguredAccountIds,
  normalizeAccountId,
  normalizeOptionalAccountId,
  resolveListedDefaultAccountId,
} from "./account-id.js";
export { resolveMergedAccountConfig } from "./account-resolution.js";
export { resolveUserPath };
export type { OpenClawConfig };

export function resolveNormalizedAccountEntry<T>(
  entries: Record<string, T> | undefined,
  accountId: string,
  normalize: (value: string | undefined | null) => string,
): T | undefined {
  if (!entries || typeof entries !== "object") {
    return undefined;
  }
  const normalizedTarget = normalize(accountId);
  for (const [key, value] of Object.entries(entries)) {
    if (normalize(key) === normalizedTarget) {
      return value;
    }
  }
  return undefined;
}

export function resolveAccountEntry<T>(
  entries: Record<string, T> | undefined,
  accountId: string,
): T | undefined {
  return entries?.[accountId];
}

export function resolveAccountWithDefaultFallback<T>(params: {
  entries: Record<string, T> | undefined;
  accountId: string;
  defaultAccountId?: string;
  normalize?: (value: string | undefined | null) => string;
}): T | undefined {
  const normalize = params.normalize ?? ((value: string | undefined | null) => value?.trim() ?? "");
  return (
    resolveNormalizedAccountEntry(params.entries, params.accountId, normalize) ??
    (params.defaultAccountId
      ? resolveNormalizedAccountEntry(params.entries, params.defaultAccountId, normalize)
      : undefined)
  );
}

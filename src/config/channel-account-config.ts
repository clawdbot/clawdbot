import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAccountEntry, resolveNormalizedAccountEntry } from "../routing/account-lookup.js";

type AccountMergeOptions = {
  omitKeys?: string[];
  nestedObjectKeys?: string[];
  inheritEmptyKeys?: Record<string, "array" | "object">;
  preserveRootAllowFrom?: boolean;
};

/** Merge authored account overrides over channel defaults, with owner-selected collection rules. */
export function mergeAccountConfig<TConfig extends Record<string, unknown>>(
  params: AccountMergeOptions & {
    channelConfig: TConfig | undefined;
    accountConfig: Partial<TConfig> | undefined;
  },
): TConfig {
  const omitKeys = new Set(["accounts", ...(params.omitKeys ?? [])]);
  const base = Object.fromEntries(
    Object.entries(params.channelConfig ?? {}).filter(([key]) => !omitKeys.has(key)),
    // SAFETY: Callers omit only root metadata that is not part of the account config.
  ) as TConfig;
  const account = params.accountConfig;
  const merged = { ...base, ...account };
  const mergedFields: Record<string, unknown> = merged;
  for (const [key, kind] of Object.entries(params.inheritEmptyKeys ?? {})) {
    const value = account?.[key];
    const collection =
      kind === "array" ? (Array.isArray(value) ? value : undefined) : asOptionalRecord(value);
    if (collection && Object.keys(collection).length === 0) {
      mergedFields[key] = base[key];
    }
  }
  for (const key of params.nestedObjectKeys ?? []) {
    const baseValue = asOptionalRecord(base[key]);
    const accountValue = asOptionalRecord(account?.[key]);
    if (baseValue && accountValue) {
      mergedFields[key] = { ...baseValue, ...accountValue };
    }
  }
  // A restrictive root allowlist is a security boundary for owners opting into
  // this rule: an account wildcard cannot silently widen it to every sender.
  if (
    params.preserveRootAllowFrom &&
    Array.isArray(base.allowFrom) &&
    Array.isArray(account?.allowFrom)
  ) {
    const restrictiveRoot = base.allowFrom.some((entry) => {
      const value = String(entry).trim();
      return value.length > 0 && value !== "*";
    });
    if (restrictiveRoot && account.allowFrom.some((entry) => String(entry).trim() === "*")) {
      const entries = account.allowFrom.filter((entry) => String(entry).trim() !== "*");
      mergedFields.allowFrom = entries.length > 0 ? entries : base.allowFrom;
    }
  }
  return merged;
}

/** Resolve a named account before applying the shared channel inheritance rules. */
export function resolveMergedAccountConfig<TConfig extends Record<string, unknown>>(
  params: AccountMergeOptions & {
    channelConfig: TConfig | undefined;
    accounts: Record<string, Partial<TConfig>> | undefined;
    accountId: string;
    normalizeAccountId?: (accountId: string) => string;
  },
): TConfig {
  const accountConfig = params.normalizeAccountId
    ? resolveNormalizedAccountEntry(params.accounts, params.accountId, params.normalizeAccountId)
    : resolveAccountEntry(params.accounts, params.accountId);
  return mergeAccountConfig({ ...params, accountConfig });
}

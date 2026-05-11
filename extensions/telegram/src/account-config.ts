import {
  normalizeAccountId,
  resolveAccountEntry,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-core";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";

function normalizeAllowFromEntry(value: string | number): string {
  return String(value).trim();
}

function hasWildcardAllowFrom(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => normalizeAllowFromEntry(entry as string | number) === "*")
  );
}

function hasRestrictiveAllowFrom(value: unknown): value is Array<string | number> {
  return (
    Array.isArray(value) &&
    value.some((entry) => {
      const normalized = normalizeAllowFromEntry(entry as string | number);
      return normalized.length > 0 && normalized !== "*";
    })
  );
}

function dropWildcardAllowFrom(value: Array<string | number>): Array<string | number> {
  return value.filter((entry) => normalizeAllowFromEntry(entry) !== "*");
}

function resolveMergedAllowFrom(params: {
  baseAllowFrom?: Array<string | number>;
  accountAllowFrom?: Array<string | number>;
}): Array<string | number> | undefined {
  const { baseAllowFrom, accountAllowFrom } = params;
  if (hasRestrictiveAllowFrom(baseAllowFrom) && hasWildcardAllowFrom(accountAllowFrom)) {
    const accountRestrictiveEntries = Array.isArray(accountAllowFrom)
      ? dropWildcardAllowFrom(accountAllowFrom)
      : [];
    return accountRestrictiveEntries.length > 0 ? accountRestrictiveEntries : baseAllowFrom;
  }
  return accountAllowFrom ?? baseAllowFrom;
}

export function resolveTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig | undefined {
  const normalized = normalizeAccountId(accountId);
  return resolveAccountEntry(cfg.channels?.telegram?.accounts, normalized);
}

export function mergeTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig {
  const {
    accounts: _ignored,
    defaultAccount: _ignoredDefaultAccount,
    groups: channelGroups,
    ...base
  } = (cfg.channels?.telegram ?? {}) as TelegramAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const account = resolveTelegramAccountConfig(cfg, accountId) ?? {};

  // Multi-account bots must not inherit channel-level groups unless explicitly set.
  const configuredAccountIds = Object.keys(cfg.channels?.telegram?.accounts ?? {});
  const isMultiAccount = configuredAccountIds.length > 1;
  const groups = account.groups ?? (isMultiAccount ? undefined : channelGroups);
  const allowFrom = resolveMergedAllowFrom({
    baseAllowFrom: base.allowFrom,
    accountAllowFrom: account.allowFrom,
  });

  return { ...base, ...account, allowFrom, groups };
}

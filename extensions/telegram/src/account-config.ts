// Telegram helper module supports account config behavior.
import {
  normalizeAccountId,
  resolveNormalizedAccountEntry,
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
  return resolveNormalizedAccountEntry(
    cfg.channels?.telegram?.accounts,
    normalized,
    normalizeAccountId,
  );
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

  // Root groups are shared defaults; an account groups map replaces the whole map.
  // In multi-account configs an explicit empty map remains an account-local opt-out,
  // while the single-account empty-map migration artifact still falls back to root.
  const configuredAccountIds = Object.keys(cfg.channels?.telegram?.accounts ?? {});
  const isMultiAccount = configuredAccountIds.length > 1;
  const hasAccountGroups = account.groups && Object.keys(account.groups).length > 0;
  const groups = isMultiAccount
    ? (account.groups ?? channelGroups)
    : hasAccountGroups
      ? account.groups
      : channelGroups;
  const allowFrom = resolveMergedAllowFrom({
    baseAllowFrom: base.allowFrom,
    accountAllowFrom: account.allowFrom,
  });
  const capabilities =
    Array.isArray(account.capabilities) && account.capabilities.length === 0
      ? base.capabilities
      : (account.capabilities ?? base.capabilities);

  return { ...base, ...account, allowFrom, capabilities, groups };
}

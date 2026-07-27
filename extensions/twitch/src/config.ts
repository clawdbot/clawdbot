import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
// Twitch helper module supports config behavior.
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveNormalizedAccountEntry,
} from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTwitchToken, type TwitchTokenResolution } from "./token.js";
import type { TwitchAccountConfig } from "./types.js";
import { isAccountConfigured } from "./utils/twitch.js";

export { DEFAULT_ACCOUNT_ID };

export type ResolvedTwitchAccount = TwitchAccountConfig & { accountId: string };

const { listAccountIds, resolveDefaultAccountId: resolveDefaultTwitchAccountId } =
  createAccountListHelpers("twitch", {
    normalizeAccountId,
    fallbackAccountIdWhenEmpty: false,
    hasImplicitDefaultAccount: (cfg) => {
      const twitch = cfg.channels?.twitch as Record<string, unknown> | undefined;
      return (
        typeof twitch?.username === "string" ||
        typeof twitch?.accessToken === "string" ||
        typeof twitch?.channel === "string"
      );
    },
  });

export { resolveDefaultTwitchAccountId };

type ResolvedTwitchAccountContext = {
  accountId: string;
  account: TwitchAccountConfig | null;
  tokenResolution: TwitchTokenResolution;
  configured: boolean;
  availableAccountIds: string[];
};

/**
 * Get account config from core config
 *
 * Handles two patterns:
 * 1. Simplified single-account: base-level properties create implicit "default" account
 * 2. Multi-account: explicit accounts object
 *
 * For "default" account, base-level properties take precedence over accounts.default
 * For other accounts, only the accounts object is checked
 */
export function getAccountConfig(
  coreConfig: unknown,
  accountId: string,
): TwitchAccountConfig | null {
  if (!coreConfig || typeof coreConfig !== "object") {
    return null;
  }

  const cfg = coreConfig as OpenClawConfig;
  const normalizedAccountId = normalizeAccountId(accountId);
  const twitch = cfg.channels?.twitch;
  // Access accounts via unknown to handle union type (single-account vs multi-account)
  const twitchRaw = twitch as Record<string, unknown> | undefined;
  const accounts = twitchRaw?.accounts as Record<string, TwitchAccountConfig> | undefined;

  // For default account, check base-level config first
  if (normalizedAccountId === DEFAULT_ACCOUNT_ID) {
    const accountFromAccounts = resolveNormalizedAccountEntry(
      accounts,
      DEFAULT_ACCOUNT_ID,
      normalizeAccountId,
    );

    // Base-level properties that can form an implicit default account
    const baseLevel = {
      username: typeof twitchRaw?.username === "string" ? twitchRaw.username : undefined,
      accessToken: typeof twitchRaw?.accessToken === "string" ? twitchRaw.accessToken : undefined,
      clientId: typeof twitchRaw?.clientId === "string" ? twitchRaw.clientId : undefined,
      channel: typeof twitchRaw?.channel === "string" ? twitchRaw.channel : undefined,
      enabled: typeof twitchRaw?.enabled === "boolean" ? twitchRaw.enabled : undefined,
      allowFrom: Array.isArray(twitchRaw?.allowFrom) ? twitchRaw.allowFrom : undefined,
      allowedRoles: Array.isArray(twitchRaw?.allowedRoles) ? twitchRaw.allowedRoles : undefined,
      requireMention:
        typeof twitchRaw?.requireMention === "boolean" ? twitchRaw.requireMention : undefined,
      clientSecret:
        typeof twitchRaw?.clientSecret === "string" ? twitchRaw.clientSecret : undefined,
      refreshToken:
        typeof twitchRaw?.refreshToken === "string" ? twitchRaw.refreshToken : undefined,
      expiresIn: typeof twitchRaw?.expiresIn === "number" ? twitchRaw.expiresIn : undefined,
      obtainmentTimestamp:
        typeof twitchRaw?.obtainmentTimestamp === "number"
          ? twitchRaw.obtainmentTimestamp
          : undefined,
    };

    // Merge: base-level takes precedence over accounts.default
    const merged: Partial<TwitchAccountConfig> = {
      ...accountFromAccounts,
      ...baseLevel,
    } as Partial<TwitchAccountConfig>;

    // Only return if we have at least username
    if (merged.username) {
      return merged as TwitchAccountConfig;
    }

    // Fall through to accounts.default if no base-level username
    if (accountFromAccounts) {
      return accountFromAccounts;
    }

    return null;
  }

  // For non-default accounts, only check accounts object
  const account = resolveNormalizedAccountEntry(accounts, normalizedAccountId, normalizeAccountId);
  if (!account) {
    return null;
  }

  return account;
}

export function resolveTwitchAccountContext(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedTwitchAccountContext {
  const resolvedAccountId = accountId?.trim()
    ? normalizeAccountId(accountId)
    : resolveDefaultTwitchAccountId(cfg);
  const account = getAccountConfig(cfg, resolvedAccountId);
  const tokenResolution = resolveTwitchToken(cfg, { accountId: resolvedAccountId });
  return {
    accountId: resolvedAccountId,
    account,
    tokenResolution,
    configured: account ? isAccountConfigured(account, tokenResolution.token) : false,
    availableAccountIds: listAccountIds(cfg),
  };
}

/** Keep runtime and setup on the same normalized, account-scoped credential path. */
function resolveTwitchAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedTwitchAccount {
  const resolvedAccountId = normalizeAccountId(accountId ?? resolveDefaultTwitchAccountId(cfg));
  const account = getAccountConfig(cfg, resolvedAccountId);
  return account
    ? { accountId: resolvedAccountId, ...account }
    : {
        accountId: resolvedAccountId,
        username: "",
        accessToken: "",
        clientId: "",
        channel: "",
        enabled: false,
      };
}

/** Share account selection and configured-state checks across both Twitch entrypoints. */
export const twitchConfigAdapter = {
  listAccountIds,
  resolveAccount: resolveTwitchAccount,
  defaultAccountId: resolveDefaultTwitchAccountId,
  isConfigured: (account: ResolvedTwitchAccount, cfg: OpenClawConfig) =>
    resolveTwitchAccountContext(cfg, account.accountId).configured,
  isEnabled: (account: ResolvedTwitchAccount | undefined) => account?.enabled !== false,
};

export function resolveTwitchSnapshotAccountId(
  cfg: OpenClawConfig,
  account: TwitchAccountConfig,
): string {
  const twitch = (cfg as Record<string, unknown>).channels as Record<string, unknown> | undefined;
  const twitchCfg = twitch?.twitch as Record<string, unknown> | undefined;
  const accountMap = (twitchCfg?.accounts as Record<string, unknown> | undefined) ?? {};
  return (
    Object.entries(accountMap).find(([, value]) => value === account)?.[0] ?? DEFAULT_ACCOUNT_ID
  );
}

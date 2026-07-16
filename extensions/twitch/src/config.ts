import { listCombinedAccountIds } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveTwitchToken, type TwitchTokenResolution } from "./token.js";
import type { TwitchAccountConfig } from "./types.js";
import { isAccountConfigured } from "./utils/twitch.js";

/**
 * Default account ID for Twitch
 */
export const DEFAULT_ACCOUNT_ID = "default";

export type ResolvedTwitchAccountContext = {
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
  const twitch = cfg.channels?.twitch;
  // Access accounts via unknown to handle union type (single-account vs multi-account)
  const twitchRaw = twitch as Record<string, unknown> | undefined;
  const accounts = twitchRaw?.accounts as Record<string, TwitchAccountConfig> | undefined;

  // For default account, check base-level config first
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const accountFromAccounts = accounts?.[DEFAULT_ACCOUNT_ID];

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
  if (!accounts || !accounts[accountId]) {
    return null;
  }

  return accounts[accountId] as TwitchAccountConfig | null;
}

/**
 * List all configured account IDs
 *
 * Includes both explicit accounts and implicit "default" from base-level config
 */
export function listAccountIds(cfg: OpenClawConfig): string[] {
  const twitch = cfg.channels?.twitch;
  // Access accounts via unknown to handle union type (single-account vs multi-account)
  const twitchRaw = twitch as Record<string, unknown> | undefined;
  const accountMap = twitchRaw?.accounts as Record<string, unknown> | undefined;

  // Add implicit "default" if base-level config exists and "default" not already present
  const hasBaseLevelConfig =
    twitchRaw &&
    (typeof twitchRaw.username === "string" ||
      typeof twitchRaw.accessToken === "string" ||
      typeof twitchRaw.channel === "string");

  return listCombinedAccountIds({
    configuredAccountIds: Object.keys(accountMap ?? {}),
    implicitAccountId: hasBaseLevelConfig ? DEFAULT_ACCOUNT_ID : undefined,
  });
}

export function resolveDefaultTwitchAccountId(cfg: OpenClawConfig): string {
  const preferred =
    typeof cfg.channels?.twitch?.defaultAccount === "string"
      ? cfg.channels.twitch.defaultAccount.trim()
      : "";
  const ids = listAccountIds(cfg);
  if (preferred && ids.includes(preferred)) {
    return preferred;
  }
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveTwitchAccountContext(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedTwitchAccountContext {
  const resolvedAccountId = accountId?.trim() || resolveDefaultTwitchAccountId(cfg);
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

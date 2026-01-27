import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import type { TwitchAccountConfig } from "./types.js";

/**
 * Default account ID for Twitch
 */
export const DEFAULT_ACCOUNT_ID = "default";

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

  const cfg = coreConfig as MoltbotConfig;
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
export function listAccountIds(cfg: MoltbotConfig): string[] {
  const twitch = cfg.channels?.twitch;
  // Access accounts via unknown to handle union type (single-account vs multi-account)
  const twitchRaw = twitch as Record<string, unknown> | undefined;
  const accountMap = twitchRaw?.accounts as Record<string, unknown> | undefined;

  const ids: string[] = [];

  // Add explicit accounts
  if (accountMap) {
    ids.push(...Object.keys(accountMap));
  }

  // Add implicit "default" if base-level config exists and "default" not already present
  const hasBaseLevelConfig =
    twitchRaw &&
    (typeof twitchRaw.username === "string" ||
      typeof twitchRaw.accessToken === "string" ||
      typeof twitchRaw.channel === "string");

  if (hasBaseLevelConfig && !ids.includes(DEFAULT_ACCOUNT_ID)) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  return ids;
}

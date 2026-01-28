/**
 * Webex account resolution
 *
 * Handles single-account and multi-account configurations.
 */

import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import { parseWebexBotToken } from "./auth.js";
import type {
  DEFAULT_ACCOUNT_ID,
  ResolvedWebexAccount,
  WebexAccountConfig,
  WebexConfig,
  WebexCredentialSource,
} from "./types.js";

const DEFAULT_ID = "default" as typeof DEFAULT_ACCOUNT_ID;

/**
 * List all configured account IDs
 */
export function listWebexAccountIds(cfg: MoltbotConfig): string[] {
  const channel = cfg.channels?.["webex"] as WebexConfig | undefined;
  if (!channel) {
    return [DEFAULT_ID];
  }

  const accountIds = new Set<string>();

  // Check for multi-account config
  if (channel.accounts) {
    for (const id of Object.keys(channel.accounts)) {
      accountIds.add(id);
    }
  }

  // Check for single-account config (base level)
  if (channel.botToken || process.env.WEBEX_BOT_TOKEN) {
    accountIds.add(DEFAULT_ID);
  }

  // Always include default if nothing configured (for setup flow)
  if (accountIds.size === 0) {
    accountIds.add(DEFAULT_ID);
  }

  return Array.from(accountIds).sort((a, b) => a.localeCompare(b));
}

/**
 * Get the default account ID
 */
export function resolveDefaultWebexAccountId(cfg: MoltbotConfig): string {
  const channel = cfg.channels?.["webex"] as WebexConfig | undefined;

  // Check explicit default
  if (channel?.defaultAccount?.trim()) {
    return channel.defaultAccount.trim();
  }

  const ids = listWebexAccountIds(cfg);

  // Prefer "default" if it exists
  if (ids.includes(DEFAULT_ID)) {
    return DEFAULT_ID;
  }

  return ids[0] ?? DEFAULT_ID;
}

/**
 * Resolve credentials for an account
 */
function resolveWebexCredentials(params: {
  accountId: string;
  account: WebexAccountConfig;
}): {
  botToken?: string;
  source: WebexCredentialSource;
} {
  const { accountId, account } = params;

  // 1. Config-level botToken
  if (account.botToken?.trim()) {
    return { botToken: account.botToken.trim(), source: "config" };
  }

  // 2. Environment variable (only for default account)
  if (accountId === DEFAULT_ID) {
    const envToken = process.env.WEBEX_BOT_TOKEN?.trim();
    if (envToken) {
      return { botToken: envToken, source: "env" };
    }
  }

  return { source: "none" };
}

/**
 * Resolve a single account configuration
 */
export function resolveWebexAccount(params: {
  cfg: MoltbotConfig;
  accountId?: string;
}): ResolvedWebexAccount {
  const channel = params.cfg.channels?.["webex"] as WebexConfig | undefined;
  const accountId = params.accountId ?? resolveDefaultWebexAccountId(params.cfg);

  // Build account config by merging base + account-specific
  let accountConfig: WebexAccountConfig = {};

  // Base level config (for single-account mode)
  const baseConfig: WebexAccountConfig = {
    enabled: channel?.enabled,
    botToken: channel?.botToken,
    webhookSecret: channel?.webhookSecret,
    webhookPath: channel?.webhookPath,
    webhookUrl: channel?.webhookUrl,
    botId: channel?.botId,
    botEmail: channel?.botEmail,
    dm: channel?.dm,
    groupPolicy: channel?.groupPolicy,
    rooms: channel?.rooms,
  };

  // Check for multi-account config
  const multiAccountConfig = channel?.accounts?.[accountId];

  if (multiAccountConfig) {
    // Multi-account mode: merge base with account-specific (account wins)
    accountConfig = {
      ...baseConfig,
      ...multiAccountConfig,
      dm: { ...baseConfig.dm, ...multiAccountConfig.dm },
      rooms: { ...baseConfig.rooms, ...multiAccountConfig.rooms },
    };
  } else if (accountId === DEFAULT_ID) {
    // Single-account mode: use base config
    accountConfig = baseConfig;
  } else {
    // Unknown account ID - return empty/disabled
    accountConfig = { enabled: false };
  }

  // Resolve credentials
  const { botToken, source } = resolveWebexCredentials({ accountId, account: accountConfig });

  // Validate token format
  const tokenInfo = parseWebexBotToken(botToken);

  // Get bot ID/email from config or environment
  let botId = accountConfig.botId?.trim();
  let botEmail = accountConfig.botEmail?.trim();

  if (!botId && accountId === DEFAULT_ID) {
    botId = process.env.WEBEX_BOT_ID?.trim();
  }
  if (!botEmail && accountId === DEFAULT_ID) {
    botEmail = process.env.WEBEX_BOT_EMAIL?.trim();
  }

  return {
    accountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled ?? true,
    config: accountConfig,
    credentialSource: source,
    botToken: tokenInfo.valid ? botToken : undefined,
    botId,
    botEmail,
  };
}

/**
 * Check if an account is configured (has valid credentials)
 */
export function isWebexAccountConfigured(account: ResolvedWebexAccount): boolean {
  return account.credentialSource !== "none" && !!account.botToken;
}

/**
 * Get a human-readable description of an account
 */
export function describeWebexAccount(account: ResolvedWebexAccount): {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  credentialSource: WebexCredentialSource;
} {
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: isWebexAccountConfigured(account),
    credentialSource: account.credentialSource,
  };
}

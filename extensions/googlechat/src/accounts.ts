import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "clawdbot/plugin-sdk";
import type { GoogleChatAccountConfig, GoogleChatConfig } from "./types.js";

export type ResolvedGoogleChatAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  projectId?: string;
  // Pub/Sub mode
  subscriptionName?: string;
  credentialsPath?: string;
  // Webhook mode
  webhookMode?: boolean;
  webhookPort?: number;
  webhookHost?: string;
  webhookPath?: string;
  webhookPublicUrl?: string;
  config: GoogleChatAccountConfig;
};

export function listGoogleChatAccountIds(cfg: ClawdbotConfig): string[] {
  const googlechat = (cfg.channels?.googlechat ?? {}) as GoogleChatConfig;
  const accounts = googlechat.accounts ?? {};

  // Check if top-level config exists (single account mode)
  const hasTopLevel = Boolean(googlechat.projectId?.trim());

  if (Object.keys(accounts).length === 0 && hasTopLevel) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return Object.keys(accounts);
}

export function resolveDefaultGoogleChatAccountId(
  cfg: ClawdbotConfig,
): string {
  const ids = listGoogleChatAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveGoogleChatAccount(options: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): ResolvedGoogleChatAccount {
  const { cfg, accountId } = options;
  const googlechat = (cfg.channels?.googlechat ?? {}) as GoogleChatConfig;

  const resolvedAccountId = accountId ?? resolveDefaultGoogleChatAccountId(cfg);

  // Try account-specific config first
  const accountConfig = googlechat.accounts?.[resolvedAccountId];

  // Fall back to top-level config for single-account setups
  const config: GoogleChatAccountConfig = accountConfig ?? {
    name: googlechat.name,
    enabled: googlechat.enabled,
    projectId: googlechat.projectId,
    subscriptionName: googlechat.subscriptionName,
    credentialsPath: googlechat.credentialsPath,
    webhookMode: googlechat.webhookMode,
    webhookPort: googlechat.webhookPort,
    webhookHost: googlechat.webhookHost,
    webhookPath: googlechat.webhookPath,
    webhookPublicUrl: googlechat.webhookPublicUrl,
    dmPolicy: googlechat.dmPolicy,
    allowFrom: googlechat.allowFrom,
    spacePolicy: googlechat.spacePolicy,
    allowSpaces: googlechat.allowSpaces,
    historyLimit: googlechat.historyLimit,
    dmHistoryLimit: googlechat.dmHistoryLimit,
    textChunkLimit: googlechat.textChunkLimit,
    messagePrefix: googlechat.messagePrefix,
  };

  return {
    accountId: resolvedAccountId,
    name: config.name,
    enabled: config.enabled !== false,
    projectId: config.projectId,
    subscriptionName: config.subscriptionName,
    credentialsPath: config.credentialsPath,
    webhookMode: config.webhookMode,
    webhookPort: config.webhookPort,
    webhookHost: config.webhookHost,
    webhookPath: config.webhookPath,
    webhookPublicUrl: config.webhookPublicUrl,
    config,
  };
}

/**
 * Common root-level channel config keys safe to promote into a single account.
 */
const COMMON_SINGLE_ACCOUNT_PROMOTION_KEYS = [
  "name",
  "token",
  "tokenFile",
  // Tencent's out-of-tree @wecom/wecom-openclaw-plugin still writes root
  // botId/secret. Keep promoting them until WeCom publishes plugin declarations.
  "botId",
  "secret",
  "botToken",
  "webhookPath",
  "webhookUrl",
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
  "defaultTo",
] as const;

/**
 * Setup-only config keys that can move during single-account migration.
 */
const SETUP_SINGLE_ACCOUNT_PROMOTION_KEYS = [
  ...COMMON_SINGLE_ACCOUNT_PROMOTION_KEYS,
  "streaming",
  "allowBots",
  "blockStreaming",
  "replyToMode",
  "textChunkLimit",
  "chunkMode",
  "responsePrefix",
  "ackReaction",
  "ackReactionScope",
  "reactionNotifications",
  "threadBindings",
  "mediaMaxMb",
  "dm",
  "groups",
  "actions",
] as const;

const commonSingleAccountPromotionKeys = new Set<string>(COMMON_SINGLE_ACCOUNT_PROMOTION_KEYS);
const setupSingleAccountPromotionKeys = new Set<string>(SETUP_SINGLE_ACCOUNT_PROMOTION_KEYS);

/**
 * Returns whether a config key is part of the channel-agnostic promotion set.
 */
export function isCommonSingleAccountPromotionKey(key: string): boolean {
  return commonSingleAccountPromotionKeys.has(key);
}

/**
 * Returns whether a config key can be promoted by setup migration flows.
 */
export function isSetupSingleAccountPromotionKey(key: string): boolean {
  return setupSingleAccountPromotionKeys.has(key);
}

/**
 * Lists root-level channel keys that could be promoted into account config.
 */
export function collectSingleAccountPromotionEntries(channel: Record<string, unknown>): {
  entries: string[];
  hasNamedAccounts: boolean;
} {
  const hasNamedAccounts = Object.keys((channel.accounts as Record<string, unknown>) ?? {}).some(
    Boolean,
  );
  const entries = Object.entries(channel)
    .filter(
      ([key, value]) =>
        key !== "accounts" && key !== "defaultAccount" && key !== "enabled" && value !== undefined,
    )
    .map(([key]) => key);
  return { entries, hasNamedAccounts };
}

import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";

export const matrixSingleAccountKeysToMove = [
  "deviceId",
  "avatarUrl",
  "initialSyncLimit",
  "encryption",
  "allowlistOnly",
  "allowBots",
  "blockStreaming",
  "replyToMode",
  "threadReplies",
  "textChunkLimit",
  "chunkMode",
  "responsePrefix",
  "ackReaction",
  "ackReactionScope",
  "reactionNotifications",
  "threadBindings",
  "startupVerification",
  "startupVerificationCooldownHours",
  "mediaMaxMb",
  "autoJoin",
  "autoJoinAllowlist",
  "dm",
  "groups",
  "rooms",
  "actions",
] as const;

export const matrixNamedAccountPromotionKeys = [
  // When named accounts already exist, only move auth/bootstrap fields into the
  // promoted account. Shared delivery-policy fields stay at the top level.
  "name",
  "homeserver",
  "userId",
  "accessToken",
  "password",
  "deviceId",
  "deviceName",
  "avatarUrl",
  "initialSyncLimit",
  "encryption",
] as const;

export const singleAccountKeysToMove = [...matrixSingleAccountKeysToMove];
export const namedAccountPromotionKeys = [...matrixNamedAccountPromotionKeys];

export function resolveSingleAccountPromotionTarget(params: {
  channel: Record<string, unknown>;
}): string {
  const accounts =
    typeof params.channel.accounts === "object" && params.channel.accounts
      ? (params.channel.accounts as Record<string, unknown>)
      : {};
  const normalizedDefaultAccount =
    typeof params.channel.defaultAccount === "string" && params.channel.defaultAccount.trim()
      ? normalizeAccountId(params.channel.defaultAccount)
      : undefined;
  const matchedAccountId = normalizedDefaultAccount
    ? Object.entries(accounts).find(
        ([accountId, value]) =>
          accountId &&
          value &&
          typeof value === "object" &&
          normalizeAccountId(accountId) === normalizedDefaultAccount,
      )?.[0]
    : undefined;
  if (matchedAccountId) {
    return matchedAccountId;
  }
  if (normalizedDefaultAccount) {
    return DEFAULT_ACCOUNT_ID;
  }
  const namedAccounts = Object.entries(accounts).filter(
    ([accountId, value]) => accountId && typeof value === "object" && value,
  );
  if (namedAccounts.length === 1) {
    return namedAccounts[0][0];
  }
  if (
    namedAccounts.length > 1 &&
    accounts[DEFAULT_ACCOUNT_ID] &&
    typeof accounts[DEFAULT_ACCOUNT_ID] === "object"
  ) {
    return DEFAULT_ACCOUNT_ID;
  }
  return DEFAULT_ACCOUNT_ID;
}

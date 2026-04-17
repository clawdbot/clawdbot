import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getBundledChannelPlugin } from "./bundled.js";
import { getChannelPlugin } from "./registry.js";

type ChannelSectionBase = {
  defaultAccount?: string;
  accounts?: Record<string, Record<string, unknown>>;
};

const COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set([
  "name",
  "token",
  "tokenFile",
  "botToken",
  "appToken",
  "account",
  "signalNumber",
  "authDir",
  "cliPath",
  "dbPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "webhookPath",
  "webhookUrl",
  "webhookSecret",
  "service",
  "region",
  "homeserver",
  "userId",
  "accessToken",
  "password",
  "deviceName",
  "url",
  "code",
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
  "defaultTo",
]);

const BUNDLED_SINGLE_ACCOUNT_PROMOTION_FALLBACKS: Record<string, readonly string[]> = {
  // Some setup/migration paths run before the channel setup surface has been loaded.
  telegram: ["streaming"],
};

const BUNDLED_NAMED_ACCOUNT_PROMOTION_FALLBACKS: Record<string, readonly string[]> = {
  // Keep top-level Telegram policy fallback intact when only auth needs seeding.
  telegram: ["botToken", "tokenFile"],
};

type ChannelSetupPromotionSurface = {
  singleAccountKeysToMove?: readonly string[];
  namedAccountPromotionKeys?: readonly string[];
  resolveSingleAccountPromotionTarget?: (params: {
    channel: ChannelSectionBase;
  }) => string | undefined;
};

function getChannelSetupPromotionSurface(channelKey: string): ChannelSetupPromotionSurface | null {
  const setup = getChannelPlugin(channelKey)?.setup ?? getBundledChannelPlugin(channelKey)?.setup;
  if (!setup || typeof setup !== "object") {
    return null;
  }
  return setup as ChannelSetupPromotionSurface;
}

function isStaticSingleAccountPromotionKey(channelKey: string, key: string): boolean {
  if (COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(key)) {
    return true;
  }
  return BUNDLED_SINGLE_ACCOUNT_PROMOTION_FALLBACKS[channelKey]?.includes(key) ?? false;
}

export function shouldMoveSingleAccountChannelKey(params: {
  channelKey: string;
  key: string;
}): boolean {
  if (isStaticSingleAccountPromotionKey(params.channelKey, params.key)) {
    return true;
  }
  const contractKeys = getChannelSetupPromotionSurface(params.channelKey)?.singleAccountKeysToMove;
  if (contractKeys?.includes(params.key)) {
    return true;
  }
  return false;
}

export function resolveSingleAccountKeysToMove(params: {
  channelKey: string;
  channel: Record<string, unknown>;
}): string[] {
  const hasNamedAccounts =
    Object.keys((params.channel.accounts as Record<string, unknown>) ?? {}).filter(Boolean).length >
    0;
  const entries = Object.entries(params.channel)
    .filter(([key, value]) => key !== "accounts" && key !== "enabled" && value !== undefined)
    .map(([key]) => key);
  if (entries.length === 0) {
    return [];
  }

  let setupSurface: ChannelSetupPromotionSurface | null | undefined;
  const resolveSetupSurface = () => {
    setupSurface ??= getChannelSetupPromotionSurface(params.channelKey);
    return setupSurface;
  };

  const keysToMove = entries.filter((key) => {
    if (isStaticSingleAccountPromotionKey(params.channelKey, key)) {
      return true;
    }
    return Boolean(resolveSetupSurface()?.singleAccountKeysToMove?.includes(key));
  });
  if (!hasNamedAccounts || keysToMove.length === 0) {
    return keysToMove;
  }

  const namedAccountPromotionKeys =
    resolveSetupSurface()?.namedAccountPromotionKeys ??
    BUNDLED_NAMED_ACCOUNT_PROMOTION_FALLBACKS[params.channelKey];
  if (!namedAccountPromotionKeys) {
    return keysToMove;
  }
  return keysToMove.filter((key) => namedAccountPromotionKeys.includes(key));
}

export function resolveSingleAccountPromotionTarget(params: {
  channelKey: string;
  channel: ChannelSectionBase;
}): string {
  const accounts = params.channel.accounts ?? {};
  const resolveExistingAccountId = (targetAccountId: string): string => {
    const normalizedTargetAccountId = normalizeAccountId(targetAccountId);
    const matchedAccountId = Object.keys(accounts).find(
      (accountId) => normalizeAccountId(accountId) === normalizedTargetAccountId,
    );
    return matchedAccountId ?? normalizedTargetAccountId;
  };
  const surface = getChannelSetupPromotionSurface(params.channelKey);
  const resolved = surface?.resolveSingleAccountPromotionTarget?.({
    channel: params.channel,
  });
  const normalizedResolved = normalizeOptionalString(resolved);
  if (normalizedResolved) {
    return resolveExistingAccountId(normalizedResolved);
  }
  return resolveExistingAccountId(DEFAULT_ACCOUNT_ID);
}

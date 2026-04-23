import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getBundledChannelPlugin, hasBundledChannelPackageSetupFeature } from "./bundled.js";
import { getLoadedChannelPlugin } from "./registry.js";

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

type ChannelSetupPromotionSurface = {
  singleAccountKeysToMove?: readonly string[];
  namedAccountPromotionKeys?: readonly string[];
  resolveSingleAccountPromotionTarget?: (params: {
    channel: ChannelSectionBase;
  }) => string | undefined;
};

function asPromotionSurface(setup: unknown): ChannelSetupPromotionSurface | null {
  return setup && typeof setup === "object" ? (setup as ChannelSetupPromotionSurface) : null;
}

function getLoadedChannelSetupPromotionSurface(
  channelKey: string,
): ChannelSetupPromotionSurface | null {
  return asPromotionSurface(getLoadedChannelPlugin(channelKey)?.setup);
}

function getBundledChannelSetupPromotionSurface(
  channelKey: string,
): ChannelSetupPromotionSurface | null {
  if (!hasBundledChannelPackageSetupFeature(channelKey, "configPromotion")) {
    return null;
  }
  return asPromotionSurface(getBundledChannelPlugin(channelKey)?.setup);
}

function isStaticSingleAccountPromotionKey(key: string): boolean {
  return COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(key);
}

export function shouldMoveSingleAccountChannelKey(params: {
  channelKey: string;
  key: string;
}): boolean {
  if (isStaticSingleAccountPromotionKey(params.key)) {
    return true;
  }
  const loadedContractKeys = getLoadedChannelSetupPromotionSurface(
    params.channelKey,
  )?.singleAccountKeysToMove;
  if (loadedContractKeys?.includes(params.key)) {
    return true;
  }
  const bundledContractKeys = getBundledChannelSetupPromotionSurface(
    params.channelKey,
  )?.singleAccountKeysToMove;
  if (bundledContractKeys?.includes(params.key)) {
    return true;
  }
  return false;
}

export function resolveSingleAccountKeysToMove(params: {
  channelKey: string;
  channel: Record<string, unknown>;
}): string[] {
  const hasNamedAccounts = Object.keys(
    (params.channel.accounts as Record<string, unknown>) ?? {},
  ).some(Boolean);
  const entries = Object.entries(params.channel)
    .filter(
      ([key, value]) =>
        key !== "accounts" && key !== "defaultAccount" && key !== "enabled" && value !== undefined,
    )
    .map(([key]) => key);
  if (entries.length === 0) {
    return [];
  }

  let loadedSetupSurface: ChannelSetupPromotionSurface | null | undefined;
  const resolveLoadedSetupSurface = () => {
    loadedSetupSurface ??= getLoadedChannelSetupPromotionSurface(params.channelKey);
    return loadedSetupSurface;
  };
  let bundledSetupSurface: ChannelSetupPromotionSurface | null | undefined;
  const resolveBundledSetupSurface = () => {
    bundledSetupSurface ??= getBundledChannelSetupPromotionSurface(params.channelKey);
    return bundledSetupSurface;
  };

  const keysToMove = entries.filter((key) => {
    if (isStaticSingleAccountPromotionKey(key)) {
      return true;
    }
    return Boolean(
      resolveLoadedSetupSurface()?.singleAccountKeysToMove?.includes(key) ||
      resolveBundledSetupSurface()?.singleAccountKeysToMove?.includes(key),
    );
  });
  if (!hasNamedAccounts || keysToMove.length === 0) {
    return keysToMove;
  }

  const namedAccountPromotionKeys =
    resolveLoadedSetupSurface()?.namedAccountPromotionKeys ??
    resolveBundledSetupSurface()?.namedAccountPromotionKeys;
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
  const loadedSurface = getLoadedChannelSetupPromotionSurface(params.channelKey);
  const bundledSurface = loadedSurface?.resolveSingleAccountPromotionTarget
    ? undefined
    : getBundledChannelSetupPromotionSurface(params.channelKey);
  const resolvePromotionTarget =
    loadedSurface?.resolveSingleAccountPromotionTarget ??
    bundledSurface?.resolveSingleAccountPromotionTarget;
  const resolved = resolvePromotionTarget?.({
    channel: params.channel,
  });
  const normalizedResolved = normalizeOptionalString(resolved);
  if (normalizedResolved) {
    return resolveExistingAccountId(normalizedResolved);
  }
  return resolveExistingAccountId(DEFAULT_ACCOUNT_ID);
}

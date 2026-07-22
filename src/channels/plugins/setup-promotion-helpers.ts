/**
 * Channel setup promotion helpers.
 *
 * Moves legacy single-account channel config into account-scoped config records.
 */
import { getLoadedChannelPluginForRead } from "./registry-loaded.js";
import {
  collectSingleAccountPromotionEntries,
  isCommonSingleAccountPromotionKey,
  isSetupSingleAccountPromotionKey,
} from "./setup-promotion-keys.js";

type ChannelSectionBase = {
  defaultAccount?: string;
  accounts?: Record<string, Record<string, unknown>>;
};

export type ChannelSetupPromotionSurface = {
  singleAccountKeysToMove?: readonly string[];
  namedAccountPromotionKeys?: readonly string[];
  resolveSingleAccountPromotionTarget?: (params: {
    channel: ChannelSectionBase;
  }) => string | undefined;
};

type SingleAccountPromotionParams = {
  channelKey: string;
  channel: Record<string, unknown>;
  setupSurface?: ChannelSetupPromotionSurface;
  includeSetupKeys?: boolean;
  resolveBundledSurface?: (channelKey: string) => ChannelSetupPromotionSurface | null;
};

// Published undeclared adapters still depend on these keys: Chatu, GroupMe, OneBot,
// and WhatsApp Cloud use accessToken; Claworld uses appToken; OneBot uses httpUrl;
// MQTT and TrueConf use password; Rocket.Chat uses rooms and userId; WorkClaw and
// TIMBot use userId; Vama, Pinto, and Roam use webhookSecret (2026-07-22 sweep).
// Delete each key as soon as no published plugin reads it; no version boundary is needed.
const LEGACY_UNDECLARED_ADAPTER_PROMOTION_KEYS = {
  common: ["accessToken", "appToken", "httpUrl", "password", "userId", "webhookSecret"],
  setupOnly: ["rooms"],
} as const;

const legacyUndeclaredAdapterCommonPromotionKeys = new Set<string>(
  LEGACY_UNDECLARED_ADAPTER_PROMOTION_KEYS.common,
);
const legacyUndeclaredAdapterSetupOnlyPromotionKeys = new Set<string>(
  LEGACY_UNDECLARED_ADAPTER_PROMOTION_KEYS.setupOnly,
);

function hasPromotionDeclarations(surface: ChannelSetupPromotionSurface | null): boolean {
  return Boolean(surface && Object.hasOwn(surface, "singleAccountKeysToMove"));
}

function isLegacyUndeclaredAdapterPromotionKey(key: string, includeSetupKeys: boolean): boolean {
  return (
    legacyUndeclaredAdapterCommonPromotionKeys.has(key) ||
    (includeSetupKeys && legacyUndeclaredAdapterSetupOnlyPromotionKeys.has(key))
  );
}

function asPromotionSurface(setup: unknown): ChannelSetupPromotionSurface | null {
  return setup && typeof setup === "object" ? (setup as ChannelSetupPromotionSurface) : null;
}

function getLoadedChannelSetupPromotionSurface(
  channelKey: string,
): ChannelSetupPromotionSurface | null {
  return asPromotionSurface(getLoadedChannelPluginForRead(channelKey)?.setup);
}

/**
 * Resolves all root-level keys eligible for single-account promotion.
 */
export function resolveSingleAccountPromotion(params: SingleAccountPromotionParams) {
  const { entries, hasNamedAccounts } = collectSingleAccountPromotionEntries(params.channel);
  if (entries.length === 0) {
    return { keysToMove: [], shouldDeferPromotion: false };
  }

  const callerSetupSurface =
    params.setupSurface === undefined ? undefined : asPromotionSurface(params.setupSurface);
  let discoveredSetupSurface: ChannelSetupPromotionSurface | null | undefined;
  const resolveSetupSurface = () => {
    if (callerSetupSurface !== undefined) {
      return callerSetupSurface;
    }
    if (discoveredSetupSurface === undefined) {
      discoveredSetupSurface =
        getLoadedChannelSetupPromotionSurface(params.channelKey) ??
        params.resolveBundledSurface?.(params.channelKey) ??
        null;
    }
    return discoveredSetupSurface;
  };
  const isGenericPromotionKey = params.includeSetupKeys
    ? isSetupSingleAccountPromotionKey
    : isCommonSingleAccountPromotionKey;
  const isLegacyPromotionKey = (key: string) =>
    isLegacyUndeclaredAdapterPromotionKey(key, params.includeSetupKeys === true);
  const hasUncoveredRootKeys = entries.some(
    (key) => !isGenericPromotionKey(key) && !isLegacyPromotionKey(key),
  );
  const buildResult = (keysToMove: string[]) => ({
    keysToMove,
    shouldDeferPromotion: hasUncoveredRootKeys && !hasPromotionDeclarations(resolveSetupSurface()),
  });

  const keysToMove = entries.filter((key) => {
    if (isGenericPromotionKey(key)) {
      return true;
    }
    const setupSurface = resolveSetupSurface();
    return hasPromotionDeclarations(setupSurface)
      ? Boolean(setupSurface?.singleAccountKeysToMove?.includes(key))
      : isLegacyPromotionKey(key);
  });
  if (!hasNamedAccounts || keysToMove.length === 0) {
    return buildResult(keysToMove);
  }

  // Once named accounts exist, only keys explicitly allowed for named-account
  // promotion should move. This avoids flattening root-only channel settings.
  const namedAccountPromotionKeys = resolveSetupSurface()?.namedAccountPromotionKeys;
  if (!namedAccountPromotionKeys) {
    return buildResult(keysToMove);
  }
  return buildResult(keysToMove.filter((key) => namedAccountPromotionKeys.includes(key)));
}

/** Resolves all root-level keys eligible for single-account promotion. */
export function resolveSingleAccountKeysToMove(params: SingleAccountPromotionParams): string[] {
  return resolveSingleAccountPromotion(params).keysToMove;
}

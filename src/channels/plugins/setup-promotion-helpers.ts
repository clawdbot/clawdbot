/**
 * Channel setup promotion helpers.
 *
 * Moves legacy single-account channel config into account-scoped config records.
 */
import { getBundledChannelPlugin, hasBundledChannelPackageSetupFeature } from "./bundled.js";
import { getLoadedChannelPlugin } from "./registry.js";
import {
  collectSingleAccountPromotionEntries,
  isCommonSingleAccountPromotionKey,
} from "./setup-promotion-keys.js";

type ChannelSectionBase = {
  defaultAccount?: string;
  accounts?: Record<string, Record<string, unknown>>;
};

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

/**
 * Resolves all root-level keys eligible for single-account promotion.
 */
export function resolveSingleAccountKeysToMove(params: {
  channelKey: string;
  channel: Record<string, unknown>;
}): string[] {
  const { entries, hasNamedAccounts } = collectSingleAccountPromotionEntries(params.channel);
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
    if (isCommonSingleAccountPromotionKey(key)) {
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

  // Once named accounts exist, only keys explicitly allowed for named-account
  // promotion should move. This avoids flattening root-only channel settings.
  const namedAccountPromotionKeys =
    resolveLoadedSetupSurface()?.namedAccountPromotionKeys ??
    resolveBundledSetupSurface()?.namedAccountPromotionKeys;
  if (!namedAccountPromotionKeys) {
    return keysToMove;
  }
  return keysToMove.filter((key) => namedAccountPromotionKeys.includes(key));
}

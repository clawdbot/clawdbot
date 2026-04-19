import { normalizeAnyChannelId } from "../channels/registry.js";
import {
  resolveLegacyOutboundSendDepKeys,
  type OutboundSendDeps,
} from "../infra/outbound/send-deps.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

/**
 * CLI-internal send function sources, keyed by channel ID.
 * Each value is a lazily-loaded send function for that channel.
 */
export type CliOutboundSendSource = { [channelId: string]: unknown };

function normalizeLegacyChannelStem(raw: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(
    raw
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/_/g, "-")
      .trim(),
  );
  return normalized.replace(/-/g, "");
}

function resolveChannelIdFromLegacySourceKey(key: string): string | undefined {
  const match = key.match(/^sendMessage(.+)$/);
  if (!match) {
    return undefined;
  }
  const normalizedStem = normalizeLegacyChannelStem(match[1] ?? "");
  return normalizeAnyChannelId(normalizedStem) ?? (normalizedStem || undefined);
}

/**
 * Pass CLI send sources through as-is — both CliOutboundSendSource and
 * OutboundSendDeps are now channel-ID-keyed records.
 */
export function createOutboundSendDepsFromCliSource(deps: CliOutboundSendSource): OutboundSendDeps {
  const outbound: OutboundSendDeps = { ...deps };

  for (const legacySourceKey of Object.keys(deps)) {
    const channelId = resolveChannelIdFromLegacySourceKey(legacySourceKey);
    if (!channelId) {
      continue;
    }
    const sourceValue = deps[legacySourceKey];
    if (sourceValue !== undefined && outbound[channelId] === undefined) {
      outbound[channelId] = sourceValue;
    }
  }

  for (const channelId of Object.keys(outbound)) {
    const sourceValue = outbound[channelId];
    if (sourceValue === undefined) {
      continue;
    }
    for (const legacyDepKey of resolveLegacyOutboundSendDepKeys(channelId)) {
      if (outbound[legacyDepKey] === undefined) {
        outbound[legacyDepKey] = sourceValue;
      }
    }
  }

  return outbound;
}

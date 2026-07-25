import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import type { ChannelRouteParsedTarget } from "../../plugin-sdk/channel-route.js";
import { normalizeChannelId } from "./index.js";
import { getLoadedChannelPluginForRead } from "./registry-loaded.js";

/** Preserves the shipped `parseExplicitTarget` SDK contract until its deprecation window ends. */
export function resolveExplicitDeliveryTargetCompat(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
}): ChannelRouteParsedTarget | null {
  const channel = normalizeLowercaseStringOrEmpty(params.channel);
  const rawTo = normalizeOptionalString(params.rawTarget);
  if (!channel || !rawTo) {
    return null;
  }
  const normalizedChannel = normalizeChannelId(channel) ?? channel;
  // This deprecated hook belongs to the active plugin. Source-loading a bundled
  // plugin here turns every target parse into broad runtime discovery.
  const plugin = getLoadedChannelPluginForRead(normalizedChannel);
  const parsed = plugin?.messaging?.parseExplicitTarget?.({ raw: rawTo });
  return {
    channel,
    rawTo,
    to: parsed?.to ?? rawTo,
    threadId: normalizeOptionalThreadValue(parsed?.threadId ?? params.fallbackThreadId),
    chatType: parsed?.chatType,
  };
}

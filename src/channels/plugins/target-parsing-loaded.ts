import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import type { ChannelRouteParsedTarget } from "../../plugin-sdk/channel-route.js";
import { getChannelPlugin, normalizeChannelId } from "./index.js";
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
  const parsed =
    getLoadedChannelPluginForRead(normalizedChannel)?.messaging?.parseExplicitTarget?.({
      raw: rawTo,
    }) ??
    getChannelPlugin(normalizedChannel)?.messaging?.parseExplicitTarget?.({
      raw: rawTo,
    });
  return {
    channel,
    rawTo,
    to: parsed?.to ?? rawTo,
    threadId: normalizeOptionalThreadValue(parsed?.threadId ?? params.fallbackThreadId),
    chatType: parsed?.chatType,
  };
}

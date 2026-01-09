import type { ClawdbotConfig } from "../../config/config.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";

export function resolveReplyToMode(
  cfg: ClawdbotConfig,
  channel?: OriginatingChannelType,
): ReplyToMode {
  switch (channel) {
    case "telegram":
      return cfg.telegram?.replyToMode ?? "first";
    case "discord":
      return cfg.discord?.replyToMode ?? "off";
    case "slack":
      return cfg.slack?.replyToMode ?? "off";
    default:
      return "all";
  }
}

export function createReplyToModeFilter(
  mode: ReplyToMode,
  opts: { allowTagsWhenOff?: boolean } = {},
) {
  let hasThreaded = false;
  return (payload: ReplyPayload): ReplyPayload => {
    if (!payload.replyToId) return payload;
    if (mode === "off") {
      if (opts.allowTagsWhenOff && payload.replyToTag) return payload;
      return { ...payload, replyToId: undefined };
    }
    if (mode === "all") return payload;
    if (hasThreaded) {
      return { ...payload, replyToId: undefined };
    }
    hasThreaded = true;
    return payload;
  };
}

export function createReplyToModeFilterForChannel(
  mode: ReplyToMode,
  channel?: OriginatingChannelType,
) {
  return createReplyToModeFilter(mode, {
    allowTagsWhenOff: channel === "slack",
  });
}

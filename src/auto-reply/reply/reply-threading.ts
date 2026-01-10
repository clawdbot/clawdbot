import type { ClawdbotConfig } from "../../config/config.js";
import type { ReplyToMode } from "../../config/types.js";
import {
  getProviderPlugin,
  normalizeProviderId,
} from "../../providers/plugins/index.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";

export function resolveReplyToMode(
  cfg: ClawdbotConfig,
  channel?: OriginatingChannelType,
  accountId?: string | null,
): ReplyToMode {
  const provider = normalizeProviderId(channel);
  if (!provider) return "all";
  const resolved = getProviderPlugin(provider)?.threading?.resolveReplyToMode?.(
    {
      cfg,
      accountId,
    },
  );
  return resolved ?? "all";
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
  const provider = normalizeProviderId(channel);
  const allowTagsWhenOff = provider
    ? Boolean(getProviderPlugin(provider)?.threading?.allowTagsWhenOff)
    : false;
  return createReplyToModeFilter(mode, {
    allowTagsWhenOff,
  });
}

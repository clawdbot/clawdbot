// Explicit session keys are normalized by the channel that owns their opaque id shape.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../../auto-reply/templating.js";
import { getLoadedChannelPlugin, listChannelPlugins } from "../../channels/plugins/index.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../../sessions/session-key-utils.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";

// Candidate channels come from context and key shape because explicit keys may be prefixed.
function resolveExplicitSessionKeyNormalizerCandidates(
  sessionKey: string,
  ctx: Pick<MsgContext, "From" | "Provider" | "Surface">,
): string[] {
  const normalizedProvider = normalizeOptionalLowercaseString(ctx.Provider);
  const normalizedSurface = normalizeOptionalLowercaseString(ctx.Surface);
  const normalizedFrom = normalizeLowercaseStringOrEmpty(ctx.From);
  const candidates = new Set<string>();
  const maybeAdd = (value?: string | null) => {
    const normalized = normalizeMessageChannel(value);
    if (normalized) {
      candidates.add(normalized);
    }
  };
  maybeAdd(normalizedSurface);
  maybeAdd(normalizedProvider);
  maybeAdd(normalizedFrom.split(":", 1)[0]);
  for (const plugin of listChannelPlugins()) {
    const pluginId = normalizeMessageChannel(plugin.id);
    if (!pluginId) {
      continue;
    }
    if (sessionKey.startsWith(`${pluginId}:`) || sessionKey.includes(`:${pluginId}:`)) {
      candidates.add(pluginId);
    }
  }
  return [...candidates];
}

/** Normalizes caller-supplied session keys through the matching channel plugin when available. */
export function normalizeExplicitSessionKey(sessionKey: string, ctx: MsgContext): string {
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
  for (const channelId of resolveExplicitSessionKeyNormalizerCandidates(normalized, ctx)) {
    const normalize = getLoadedChannelPlugin(channelId)?.messaging?.normalizeExplicitSessionKey;
    const next = normalize?.({ sessionKey: normalized, ctx });
    if (typeof next === "string" && next.trim()) {
      return normalizeSessionKeyPreservingOpaquePeerIds(next);
    }
  }
  return normalized;
}

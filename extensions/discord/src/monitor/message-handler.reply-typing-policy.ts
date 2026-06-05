// Discord plugin module implements message handler.reply typing policy behavior.
import { resolveChannelMessageSourceReplyDeliveryMode } from "openclaw/plugin-sdk/channel-outbound";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";

type SourceReplyDeliveryMode = ReturnType<typeof resolveChannelMessageSourceReplyDeliveryMode>;

export type DiscordAcceptedTypingPrestartDecision = {
  sourceReplyDeliveryMode: SourceReplyDeliveryMode;
  shouldPrestart: boolean;
  reason:
    | "aborted"
    | "empty"
    | "room-event"
    | "configured-instant"
    | "configured-not-instant"
    | "tool-only"
    | "direct"
    | "mentioned-group"
    | "defer-to-message";
};

export function resolveDiscordSourceReplyDeliveryMode(
  ctx: DiscordMessagePreflightContext,
): SourceReplyDeliveryMode {
  // Keep prestart policy keyed to the same source-reply mode as dispatch.
  // Otherwise message-tool-only group replies would wait behind "message" mode.
  return resolveChannelMessageSourceReplyDeliveryMode({
    cfg: ctx.cfg,
    ctx: {
      ChatType: ctx.isDirectMessage
        ? "direct"
        : ctx.isGroupDm
          ? "group"
          : ctx.isGuildMessage
            ? "channel"
            : undefined,
      InboundEventKind: ctx.inboundEventKind,
    },
  });
}

export function resolveDiscordAcceptedTypingPrestart(
  ctx: DiscordMessagePreflightContext,
): DiscordAcceptedTypingPrestartDecision {
  const sourceReplyDeliveryMode = resolveDiscordSourceReplyDeliveryMode(ctx);
  if (ctx.abortSignal?.aborted) {
    return { sourceReplyDeliveryMode, shouldPrestart: false, reason: "aborted" };
  }
  if (!ctx.messageText.trim()) {
    return { sourceReplyDeliveryMode, shouldPrestart: false, reason: "empty" };
  }
  if (ctx.inboundEventKind === "room_event") {
    return { sourceReplyDeliveryMode, shouldPrestart: false, reason: "room-event" };
  }
  const configuredTypingMode = ctx.cfg.session?.typingMode ?? ctx.cfg.agents?.defaults?.typingMode;
  if (configuredTypingMode !== undefined) {
    // Explicit operator config wins over Discord heuristics.
    // Non-instant modes intentionally defer to the normal reply pipeline.
    return {
      sourceReplyDeliveryMode,
      shouldPrestart: configuredTypingMode === "instant",
      reason: configuredTypingMode === "instant" ? "configured-instant" : "configured-not-instant",
    };
  }
  if (sourceReplyDeliveryMode === "message_tool_only") {
    // Message-tool-only replies have no visible default response path.
    // Prestart preserves user feedback while the tool-delivered reply waits.
    return { sourceReplyDeliveryMode, shouldPrestart: true, reason: "tool-only" };
  }
  if (!ctx.isGuildMessage && !ctx.isGroupDm) {
    return { sourceReplyDeliveryMode, shouldPrestart: true, reason: "direct" };
  }
  if (ctx.effectiveWasMentioned) {
    return { sourceReplyDeliveryMode, shouldPrestart: true, reason: "mentioned-group" };
  }
  return { sourceReplyDeliveryMode, shouldPrestart: false, reason: "defer-to-message" };
}

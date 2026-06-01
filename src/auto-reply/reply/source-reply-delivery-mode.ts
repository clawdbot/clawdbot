import { normalizeChatType } from "../../channels/chat-type.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionSendPolicyDecision } from "../../sessions/send-policy.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandTurnContext, type CommandTurnContext } from "../command-turn-context.js";
import { isExplicitCommandTurnContext } from "../command-turn-detection.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

export type SourceReplyDeliveryModeContext = {
  ChatType?: string;
  InboundEventKind?: InboundEventKind;
  Provider?: string;
  Surface?: string;
  ExplicitDeliverRoute?: boolean;
  CommandAuthorized?: boolean;
  CommandBody?: string;
  CommandSource?: "text" | "native";
  CommandTurn?: CommandTurnContext;
  BotUsername?: string;
};

export function isExplicitSourceReplyCommand(
  ctx: SourceReplyDeliveryModeContext,
  cfg: OpenClawConfig,
): boolean {
  return isExplicitCommandTurnContext(ctx, cfg);
}

export function isUnauthorizedTextSlashCommand(ctx: SourceReplyDeliveryModeContext): boolean {
  const commandTurn = resolveCommandTurnContext(ctx);
  return (
    commandTurn.kind === "text-slash" &&
    !commandTurn.authorized &&
    (commandTurn.commandName !== undefined || commandTurn.body?.trim().startsWith("/") === true)
  );
}

function isInternalRoomEvent(ctx: SourceReplyDeliveryModeContext): boolean {
  return ctx.InboundEventKind === "room_event" && isInternalSourceReplyChannel(ctx);
}

export function isInternalSourceReplyChannel(ctx: SourceReplyDeliveryModeContext): boolean {
  const providerChannel = normalizeMessageChannel(ctx.Provider);
  const surfaceChannel = normalizeMessageChannel(ctx.Surface);
  const currentSurface = providerChannel ?? surfaceChannel;
  return (
    currentSurface === INTERNAL_MESSAGE_CHANNEL &&
    (surfaceChannel === INTERNAL_MESSAGE_CHANNEL || !surfaceChannel) &&
    ctx.ExplicitDeliverRoute !== true
  );
}

export function resolveSourceReplyDeliveryMode(params: {
  cfg: OpenClawConfig;
  ctx: SourceReplyDeliveryModeContext;
  requested?: SourceReplyDeliveryMode;
  strictMessageToolOnly?: boolean;
  messageToolAvailable?: boolean;
  defaultVisibleReplies?: "automatic" | "message_tool";
}): SourceReplyDeliveryMode {
  if (params.strictMessageToolOnly === true) {
    return "message_tool_only";
  }
  if (params.ctx.InboundEventKind === "room_event" && !isInternalRoomEvent(params.ctx)) {
    return "message_tool_only";
  }
  if (
    params.requested &&
    (params.requested !== "message_tool_only" || params.messageToolAvailable !== false)
  ) {
    return params.requested;
  }
  if (isExplicitSourceReplyCommand(params.ctx, params.cfg)) {
    return "automatic";
  }
  const chatType = normalizeChatType(params.ctx.ChatType);
  if (
    (chatType === "group" || chatType === "channel") &&
    isUnauthorizedTextSlashCommand(params.ctx)
  ) {
    return "message_tool_only";
  }
  let mode: SourceReplyDeliveryMode;
  if (chatType === "group" || chatType === "channel") {
    const configuredMode =
      params.cfg.messages?.groupChat?.visibleReplies ?? params.cfg.messages?.visibleReplies;
    mode = configuredMode === "message_tool" ? "message_tool_only" : "automatic";
  } else {
    const configuredMode =
      params.cfg.messages?.visibleReplies ??
      (isInternalSourceReplyChannel(params.ctx) ? "automatic" : params.defaultVisibleReplies);
    mode = configuredMode === "message_tool" ? "message_tool_only" : "automatic";
  }
  if (mode === "message_tool_only" && params.messageToolAvailable === false) {
    return "automatic";
  }
  return mode;
}

export type SourceReplyVisibilityPolicy = {
  sourceReplyDeliveryMode: SourceReplyDeliveryMode;
  sendPolicyDenied: boolean;
  suppressAutomaticSourceDelivery: boolean;
  suppressDelivery: boolean;
  suppressHookUserDelivery: boolean;
  suppressHookReplyLifecycle: boolean;
  suppressTyping: boolean;
  deliverySuppressionReason: string;
};

export function resolveSourceReplyVisibilityPolicy(params: {
  cfg: OpenClawConfig;
  ctx: SourceReplyDeliveryModeContext;
  requested?: SourceReplyDeliveryMode;
  strictMessageToolOnly?: boolean;
  sendPolicy: SessionSendPolicyDecision;
  suppressAcpChildUserDelivery?: boolean;
  explicitSuppressTyping?: boolean;
  shouldSuppressTyping?: boolean;
  messageToolAvailable?: boolean;
  defaultVisibleReplies?: "automatic" | "message_tool";
}): SourceReplyVisibilityPolicy {
  const sourceReplyDeliveryMode = resolveSourceReplyDeliveryMode({
    cfg: params.cfg,
    ctx: params.ctx,
    requested: params.requested,
    strictMessageToolOnly: params.strictMessageToolOnly,
    messageToolAvailable: params.messageToolAvailable,
    defaultVisibleReplies: params.defaultVisibleReplies,
  });
  const sendPolicyDenied = params.sendPolicy === "deny";
  const suppressAutomaticSourceDelivery = sourceReplyDeliveryMode === "message_tool_only";
  const suppressDelivery = sendPolicyDenied || suppressAutomaticSourceDelivery;
  const deliverySuppressionReason = sendPolicyDenied
    ? "sendPolicy: deny"
    : suppressAutomaticSourceDelivery
      ? "sourceReplyDeliveryMode: message_tool_only"
      : "";

  return {
    sourceReplyDeliveryMode,
    sendPolicyDenied,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
    suppressHookUserDelivery: params.suppressAcpChildUserDelivery === true || suppressDelivery,
    suppressHookReplyLifecycle:
      sendPolicyDenied ||
      params.suppressAcpChildUserDelivery === true ||
      params.explicitSuppressTyping === true ||
      params.shouldSuppressTyping === true,
    suppressTyping:
      sendPolicyDenied ||
      params.explicitSuppressTyping === true ||
      params.shouldSuppressTyping === true,
    deliverySuppressionReason,
  };
}

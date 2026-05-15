import { normalizeChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionSendPolicyDecision } from "../../sessions/send-policy.js";
import {
  isExplicitCommandTurn,
  resolveCommandTurnContext,
  type CommandTurnContext,
} from "../command-turn-context.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

export type SourceReplyDeliveryModeContext = {
  ChatType?: string;
  CommandAuthorized?: boolean;
  CommandBody?: string;
  CommandSource?: "text" | "native";
  CommandTurn?: CommandTurnContext;
};

export function isExplicitSourceReplyCommand(ctx: SourceReplyDeliveryModeContext): boolean {
  return isExplicitCommandTurn(resolveCommandTurnContext(ctx));
}

export function resolveSourceReplyDeliveryMode(params: {
  cfg: OpenClawConfig;
  ctx: SourceReplyDeliveryModeContext;
  requested?: SourceReplyDeliveryMode;
  messageToolAvailable?: boolean;
  defaultVisibleReplies?: "automatic" | "message_tool";
}): SourceReplyDeliveryMode {
  if (params.requested) {
    return params.messageToolAvailable === false && params.requested === "message_tool_only"
      ? "automatic"
      : params.requested;
  }
  if (isExplicitSourceReplyCommand(params.ctx)) {
    return "automatic";
  }
  const chatType = normalizeChatType(params.ctx.ChatType);
  let mode: SourceReplyDeliveryMode;
  if (chatType === "group" || chatType === "channel") {
    const configuredMode =
      params.cfg.messages?.groupChat?.visibleReplies ?? params.cfg.messages?.visibleReplies;
    mode = configuredMode === "automatic" ? "automatic" : "message_tool_only";
  } else {
    const configuredMode = params.cfg.messages?.visibleReplies ?? params.defaultVisibleReplies;
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

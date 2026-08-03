/**
 * Identifies messaging tools and send actions during embedded-agent runs.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import {
  CHANNEL_MESSAGE_ACTION_NAMES,
  type ChannelMessageActionName,
} from "../channels/plugins/types.public.js";
import { shouldApplyCrossContextMarker } from "../infra/outbound/outbound-policy.js";

const CORE_MESSAGING_TOOLS = new Set([
  "sessions_send",
  "conversations_send",
  "conversations_turn",
  "message",
]);
const MESSAGE_TOOL_SEND_ACTIONS = new Set([
  "send",
  "thread-reply",
  "sendWithEffect",
  "sendAttachment",
  "upload-file",
]);
const MESSAGE_TOOL_READ_ONLY_ACTIONS = new Set([
  "read",
  "reactions",
  "list-pins",
  "permissions",
  "thread-list",
  "search",
  "sticker-search",
  "member-info",
  "role-info",
  "emoji-list",
  "channel-info",
  "channel-list",
  "voice-status",
  "event-list",
  "download-file",
]);
const MESSAGE_TOOL_MUTATION_ACTIONS = new Set<string>(
  CHANNEL_MESSAGE_ACTION_NAMES.filter((action) => !MESSAGE_TOOL_READ_ONLY_ACTIONS.has(action)),
);
const MESSAGE_TOOL_CONVERSATION_CREATE_ACTIONS = new Set([
  "thread-create",
  "topic-create",
  "threadcreate",
  "createforumtopic",
]);

/** Return true when a message action sends or uploads user-visible content. */
export function isMessageToolSendActionName(action: unknown): boolean {
  const normalized = normalizeOptionalString(action) ?? "";
  return MESSAGE_TOOL_SEND_ACTIONS.has(normalized);
}

/** Return true when a message action creates a visible destination conversation. */
export function isMessageToolConversationCreateActionName(action: unknown): boolean {
  const normalized = normalizeOptionalString(action)?.toLowerCase() ?? "";
  return MESSAGE_TOOL_CONVERSATION_CREATE_ACTIONS.has(normalized);
}

// Provider docking: any plugin with `actions` opts into messaging tool handling.
/** Return true for core or channel-plugin messaging tool names. */
export function isMessagingTool(toolName: string): boolean {
  if (CORE_MESSAGING_TOOLS.has(toolName)) {
    return true;
  }
  const providerId = normalizeChannelId(toolName);
  return Boolean(providerId && getChannelPlugin(providerId)?.actions);
}

/** Return true when the specific tool invocation is an outbound send. */
export function isMessagingToolSendAction(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  const action = normalizeOptionalString(args.action) ?? "";
  if (
    toolName === "sessions_send" ||
    toolName === "conversations_send" ||
    toolName === "conversations_turn"
  ) {
    return true;
  }
  if (toolName === "message") {
    return isMessageToolSendActionName(action);
  }
  const providerId = normalizeChannelId(toolName);
  return Boolean(
    providerId && getChannelPlugin(providerId)?.actions?.extractToolSend?.({ args })?.to,
  );
}

/** Return true when a visible delivery has one target worth recording as evidence. */
export function isMessagingToolTargetEvidenceAction(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (toolName === "conversations_send" || toolName === "conversations_turn") {
    return true;
  }
  if (toolName === "message") {
    const action = normalizeOptionalString(args.action) ?? "";
    return (
      shouldApplyCrossContextMarker(action as ChannelMessageActionName) ||
      isMessageToolConversationCreateActionName(action)
    );
  }
  return isMessagingToolSendAction(toolName, args);
}

/** Return true when a messaging invocation can create visible outbound delivery. */
export function isMessagingToolDeliveryAction(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (toolName === "conversations_send" || toolName === "conversations_turn") {
    return true;
  }
  if (toolName === "message") {
    const action = normalizeOptionalString(args.action) ?? "";
    return (
      MESSAGE_TOOL_MUTATION_ACTIONS.has(action) || isMessageToolConversationCreateActionName(action)
    );
  }
  const providerId = normalizeChannelId(toolName);
  if (providerId && getChannelPlugin(providerId)?.actions?.isToolDeliveryAction?.({ args })) {
    return true;
  }
  return isMessagingToolSendAction(toolName, args);
}

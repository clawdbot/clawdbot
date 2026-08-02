/** Builds plugin hook agent context snapshots from active session and model state. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
} from "../sessions/session-key-utils.js";
import type { PluginHookChannelContext } from "./hook-channel-context.types.js";
import type { PluginHookAgentContext } from "./hook-types.js";

const TARGET_PREFIXES = new Set(["channel", "chat", "direct", "dm", "group", "thread", "user"]);

function normalizeKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function stripConversationPrefix(
  value: string | undefined,
  ...providers: Array<string | undefined>
): string | undefined {
  const text = normalizeOptionalString(value);
  if (!text) {
    return undefined;
  }

  const separatorIndex = text.indexOf(":");
  if (separatorIndex === -1) {
    return text;
  }

  const prefix = normalizeKey(text.slice(0, separatorIndex));
  const suffix = normalizeOptionalString(text.slice(separatorIndex + 1));
  if (!suffix) {
    return text;
  }
  if (
    TARGET_PREFIXES.has(prefix) ||
    providers.some((provider) => prefix === normalizeKey(provider))
  ) {
    return suffix;
  }
  return text;
}

function resolveAgentHookChannel(params: {
  messageChannel?: string | null;
  messageProvider?: string | null;
}): string | undefined {
  const messageChannel = normalizeOptionalString(params.messageChannel);
  const provider = normalizeOptionalString(params.messageProvider);
  if (!messageChannel) {
    return provider;
  }

  const separatorIndex = messageChannel.indexOf(":");
  if (separatorIndex === -1) {
    return messageChannel;
  }

  const prefix = normalizeOptionalString(messageChannel.slice(0, separatorIndex));
  if (!prefix) {
    return provider;
  }
  if (
    TARGET_PREFIXES.has(normalizeKey(prefix)) ||
    normalizeKey(prefix) === normalizeKey(provider)
  ) {
    return provider;
  }
  return prefix;
}

/** Resolves the channel id exposed to plugin agent hooks. */
function resolveAgentHookChannelId(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  currentChannelId?: string | null;
  messageTo?: string | null;
}): string | undefined {
  const provider = normalizeOptionalString(params.messageProvider);
  const messageChannel = normalizeOptionalString(params.messageChannel);
  const metadataChannel =
    stripConversationPrefix(params.currentChannelId ?? undefined, provider, messageChannel) ??
    stripConversationPrefix(params.messageTo ?? undefined, provider, messageChannel);
  if (metadataChannel && normalizeKey(metadataChannel) !== normalizeKey(provider)) {
    return metadataChannel;
  }

  const sessionBase = parseThreadSessionSuffix(params.sessionKey).baseSessionKey;
  const parsed = parseRawSessionConversationRef(sessionBase ?? params.sessionKey);
  if (parsed?.rawId) {
    return parsed.rawId;
  }

  const strippedMessageChannel = stripConversationPrefix(
    params.messageChannel ?? undefined,
    provider,
    messageChannel,
  );
  if (strippedMessageChannel && normalizeKey(strippedMessageChannel) !== normalizeKey(provider)) {
    return strippedMessageChannel;
  }
  return messageChannel ?? provider;
}

/** Builds channel/provider fields for plugin agent hook context. */
export function buildAgentHookContextChannelFields(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  currentMessageId?: string | number | null;
  currentThreadTs?: string | null;
  messageThreadId?: string | number | null;
  messageTo?: string | null;
  senderId?: string | null;
}): Pick<
  PluginHookAgentContext,
  | "accountId"
  | "channel"
  | "channelId"
  | "chatId"
  | "messageId"
  | "messageProvider"
  | "senderId"
  | "threadId"
> {
  const channel = resolveAgentHookChannel(params);
  const channelId = resolveAgentHookChannelId(params);
  const accountId = normalizeOptionalString(params.agentAccountId);
  const messageId =
    typeof params.currentMessageId === "string"
      ? normalizeOptionalString(params.currentMessageId)
      : (params.currentMessageId ?? undefined);
  const rawThreadId = params.currentThreadTs ?? params.messageThreadId;
  const threadId =
    typeof rawThreadId === "string"
      ? normalizeOptionalString(rawThreadId)
      : (rawThreadId ?? undefined);
  return {
    ...(accountId ? { accountId } : {}),
    channel,
    messageProvider: normalizeOptionalString(params.messageProvider),
    channelId,
    chatId: channelId,
    ...(messageId !== undefined ? { messageId } : {}),
    senderId: normalizeOptionalString(params.senderId),
    ...(threadId !== undefined ? { threadId } : {}),
  };
}

export function buildAgentHookContextIdentityFields(params: {
  trigger?: string | null;
  senderId?: string | null;
  chatId?: string | null;
  channelContext?: PluginHookChannelContext;
}): Pick<PluginHookAgentContext, "senderId" | "chatId" | "channelContext"> {
  const trigger = normalizeOptionalString(params.trigger);
  if (trigger && trigger !== "user") {
    return {};
  }

  const senderId = normalizeOptionalString(params.senderId);
  const chatId = normalizeOptionalString(params.chatId);
  const sender = senderId
    ? { ...params.channelContext?.sender, id: senderId }
    : params.channelContext?.sender;
  const chat = chatId
    ? { ...params.channelContext?.chat, id: chatId }
    : params.channelContext?.chat;
  const channelContext =
    sender || chat || params.channelContext
      ? {
          ...params.channelContext,
          ...(sender ? { sender } : {}),
          ...(chat ? { chat } : {}),
        }
      : undefined;

  return {
    ...(senderId ? { senderId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(channelContext ? { channelContext } : {}),
  };
}

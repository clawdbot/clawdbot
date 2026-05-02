import { parseRawSessionConversationRef } from "../sessions/session-key-utils.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { PluginHookAgentContext } from "./hook-types.js";

const TARGET_PREFIXES = new Set(["channel", "chat", "direct", "dm", "group", "thread", "user"]);

function normalizeKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function stripConversationPrefix(
  value: string | undefined,
  provider: string | undefined,
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
  if (TARGET_PREFIXES.has(prefix) || (provider && prefix === normalizeKey(provider))) {
    return suffix;
  }
  return text;
}

export function resolveAgentHookChannelId(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  currentChannelId?: string | null;
  messageTo?: string | null;
}): string | undefined {
  const provider = normalizeOptionalString(params.messageProvider);
  const parsed = parseRawSessionConversationRef(params.sessionKey);
  if (parsed?.rawId) {
    return parsed.rawId;
  }

  const metadataChannel =
    stripConversationPrefix(params.currentChannelId ?? undefined, provider) ??
    stripConversationPrefix(params.messageTo ?? undefined, provider);
  if (metadataChannel && normalizeKey(metadataChannel) !== normalizeKey(provider)) {
    return metadataChannel;
  }

  const messageChannel = stripConversationPrefix(params.messageChannel ?? undefined, provider);
  if (messageChannel && normalizeKey(messageChannel) !== normalizeKey(provider)) {
    return messageChannel;
  }
  return normalizeOptionalString(params.messageChannel) ?? provider;
}

export function buildAgentHookContextChannelFields(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  currentChannelId?: string | null;
  messageTo?: string | null;
}): Pick<PluginHookAgentContext, "channelId" | "messageProvider"> {
  return {
    messageProvider: normalizeOptionalString(params.messageProvider),
    channelId: resolveAgentHookChannelId(params),
  };
}

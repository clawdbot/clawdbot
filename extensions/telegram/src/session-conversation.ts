// Telegram plugin module implements session conversation behavior.
import { normalizeTelegramChatId, normalizeTelegramLookupTarget } from "./targets.js";
import { parseTelegramTopicConversation } from "./topic-conversation.js";

export function resolveTelegramSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}) {
  const parsed = parseTelegramTopicConversation({ conversationId: params.rawId });
  if (!parsed) {
    return null;
  }
  return {
    id: parsed.chatId,
    threadId: `${parsed.thread.scope === "direct-messages" ? "direct-topic:" : ""}${parsed.thread.id}`,
    baseConversationId: parsed.chatId,
    parentConversationCandidates: [parsed.chatId],
  };
}

export function resolveTelegramSessionTarget(params: {
  kind: "group" | "channel";
  id: string;
  threadId?: string | null;
}) {
  const raw = params.kind === "group" ? `telegram:group:${params.id}` : `telegram:${params.id}`;
  const chatId = normalizeTelegramChatId(raw) ?? normalizeTelegramLookupTarget(raw);
  const threadId = params.threadId?.startsWith("direct-topic:")
    ? params.threadId
    : params.threadId && `topic:${params.threadId}`;
  return chatId && threadId ? `${chatId}:${threadId}` : chatId;
}

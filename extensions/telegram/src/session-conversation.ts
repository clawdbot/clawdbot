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
    threadId: parsed.topicId,
    baseConversationId: parsed.chatId,
    parentConversationCandidates: [parsed.chatId],
  };
}

export function resolveTelegramSessionTarget(params: { kind: "group" | "channel"; id: string }) {
  const raw = params.kind === "group" ? `telegram:group:${params.id}` : `telegram:${params.id}`;
  return normalizeTelegramChatId(raw) ?? normalizeTelegramLookupTarget(raw);
}

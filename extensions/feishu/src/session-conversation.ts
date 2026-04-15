import { buildFeishuConversationId, parseFeishuConversationId } from "./conversation-id.js";

export function resolveFeishuParentConversationCandidates(rawId: string): string[] {
  const parsed = parseFeishuConversationId({ conversationId: rawId });
  if (!parsed) {
    return [];
  }
  switch (parsed.scope) {
    case "group_topic_sender":
      return [
        buildFeishuConversationId({
          chatId: parsed.chatId,
          scope: "group_topic",
          topicId: parsed.topicId,
        }),
        parsed.chatId,
      ];
    case "group_topic":
    case "group_sender":
      return [parsed.chatId];
    case "group":
    default:
      return [];
  }
}

export function resolveFeishuSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}) {
  const parsed = parseFeishuConversationId({ conversationId: params.rawId });
  if (!parsed) {
    return null;
  }
  return {
    id: parsed.canonicalConversationId,
    baseConversationId: parsed.chatId,
    parentConversationCandidates: resolveFeishuParentConversationCandidates(
      parsed.canonicalConversationId,
    ),
  };
}

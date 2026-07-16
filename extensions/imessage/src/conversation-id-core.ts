import { normalizeIMessageHandle, parseIMessageTarget } from "./targets.js";

export function normalizeIMessageAcpConversationId(
  conversationId: string,
): { conversationId: string } | null {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = parseIMessageTarget(trimmed);
    if (parsed.kind === "handle") {
      const handle = normalizeIMessageHandle(parsed.to);
      return handle ? { conversationId: handle } : null;
    }
    if (parsed.kind === "chat_id") {
      return { conversationId: String(parsed.chatId) };
    }
    if (parsed.kind === "chat_guid") {
      return { conversationId: parsed.chatGuid };
    }
    return { conversationId: parsed.chatIdentifier };
  } catch {
    const handle = normalizeIMessageHandle(trimmed);
    return handle ? { conversationId: handle } : null;
  }
}

export function matchIMessageAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
}): { conversationId: string; matchPriority: number } | null {
  const binding = normalizeIMessageAcpConversationId(params.bindingConversationId);
  const conversation = normalizeIMessageAcpConversationId(params.conversationId);
  if (!binding || !conversation) {
    return null;
  }
  if (binding.conversationId !== conversation.conversationId) {
    return null;
  }
  return {
    conversationId: conversation.conversationId,
    matchPriority: 2,
  };
}

export function resolveIMessageConversationIdFromTarget(target: string): string | undefined {
  return normalizeIMessageAcpConversationId(target)?.conversationId;
}

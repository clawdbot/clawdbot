import {
  extractHandleFromChatGuid,
  normalizeBlueBubblesHandle,
  parseBlueBubblesTarget,
} from "./targets.js";

export function normalizeBlueBubblesAcpConversationId(
  conversationId: string,
): { conversationId: string } | null {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = parseBlueBubblesTarget(trimmed);
    if (parsed.kind === "handle") {
      const handle = normalizeBlueBubblesHandle(parsed.to);
      return handle ? { conversationId: handle } : null;
    }
    if (parsed.kind === "chat_id") {
      return { conversationId: String(parsed.chatId) };
    }
    if (parsed.kind === "chat_guid") {
      const handle = extractHandleFromChatGuid(parsed.chatGuid);
      return {
        conversationId: handle || parsed.chatGuid,
      };
    }
    return { conversationId: parsed.chatIdentifier };
  } catch {
    const handle = normalizeBlueBubblesHandle(trimmed);
    return handle ? { conversationId: handle } : null;
  }
}

export function matchBlueBubblesAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
}): { conversationId: string; matchPriority: number } | null {
  const binding = normalizeBlueBubblesAcpConversationId(params.bindingConversationId);
  const conversation = normalizeBlueBubblesAcpConversationId(params.conversationId);
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

export function resolveBlueBubblesInboundConversationId(params: {
  isGroup: boolean;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
}): string | undefined {
  if (!params.isGroup) {
    const sender = normalizeBlueBubblesHandle(params.sender);
    return sender || undefined;
  }

  const normalized =
    (params.chatGuid && normalizeBlueBubblesAcpConversationId(params.chatGuid)?.conversationId) ||
    (params.chatIdentifier &&
      normalizeBlueBubblesAcpConversationId(params.chatIdentifier)?.conversationId) ||
    (params.chatId != null && Number.isFinite(params.chatId) ? String(params.chatId) : "");
  return normalized || undefined;
}

export function resolveBlueBubblesConversationIdFromTarget(target: string): string | undefined {
  return normalizeBlueBubblesAcpConversationId(target)?.conversationId;
}

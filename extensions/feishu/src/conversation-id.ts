import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export type FeishuGroupSessionScope =
  | "group"
  | "group_sender"
  | "group_topic"
  | "group_topic_sender";

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function buildFeishuConversationId(params: {
  chatId: string;
  scope: FeishuGroupSessionScope;
  senderOpenId?: string;
  topicId?: string;
}): string {
  const chatId = normalizeText(params.chatId) ?? "unknown";
  const senderOpenId = normalizeText(params.senderOpenId);
  const topicId = normalizeText(params.topicId);

  switch (params.scope) {
    case "group_sender":
      return senderOpenId ? `${chatId}:sender:${senderOpenId}` : chatId;
    case "group_topic":
      return topicId ? `${chatId}:topic:${topicId}` : chatId;
    case "group_topic_sender":
      if (topicId && senderOpenId) {
        return `${chatId}:topic:${topicId}:sender:${senderOpenId}`;
      }
      if (topicId) {
        return `${chatId}:topic:${topicId}`;
      }
      return senderOpenId ? `${chatId}:sender:${senderOpenId}` : chatId;
    case "group":
    default:
      return chatId;
  }
}

export function parseFeishuTargetId(raw: unknown): string | undefined {
  const target = normalizeText(raw);
  if (!target) {
    return undefined;
  }
  const withoutProvider = target.replace(/^(feishu|lark):/i, "").trim();
  if (!withoutProvider) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(withoutProvider);
  for (const prefix of ["chat:", "group:", "channel:", "user:", "dm:", "open_id:"]) {
    if (lowered.startsWith(prefix)) {
      return normalizeText(withoutProvider.slice(prefix.length));
    }
  }
  return withoutProvider;
}

export function parseFeishuDirectConversationId(raw: unknown): string | undefined {
  const target = normalizeText(raw);
  if (!target) {
    return undefined;
  }
  const withoutProvider = target.replace(/^(feishu|lark):/i, "").trim();
  if (!withoutProvider) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(withoutProvider);
  for (const prefix of ["user:", "dm:", "open_id:"]) {
    if (lowered.startsWith(prefix)) {
      return normalizeText(withoutProvider.slice(prefix.length));
    }
  }
  const id = parseFeishuTargetId(target);
  if (!id) {
    return undefined;
  }
  if (id.startsWith("ou_") || id.startsWith("on_")) {
    return id;
  }
  return undefined;
}

export function parseFeishuConversationId(params: {
  conversationId: string;
  parentConversationId?: string;
}): {
  canonicalConversationId: string;
  chatId: string;
  topicId?: string;
  senderOpenId?: string;
  scope: FeishuGroupSessionScope;
} | null {
  const conversationId = normalizeText(params.conversationId);
  const parentConversationId = normalizeText(params.parentConversationId);
  if (!conversationId) {
    return null;
  }

  const topicSenderMatch = conversationId.match(/^(.+):topic:([^:]+):sender:([^:]+)$/i);
  if (topicSenderMatch) {
    const [, chatId, topicId, senderOpenId] = topicSenderMatch;
    return {
      canonicalConversationId: buildFeishuConversationId({
        chatId,
        scope: "group_topic_sender",
        topicId,
        senderOpenId,
      }),
      chatId,
      topicId,
      senderOpenId,
      scope: "group_topic_sender",
    };
  }

  const topicMatch = conversationId.match(/^(.+):topic:([^:]+)$/i);
  if (topicMatch) {
    const [, chatId, topicId] = topicMatch;
    return {
      canonicalConversationId: buildFeishuConversationId({
        chatId,
        scope: "group_topic",
        topicId,
      }),
      chatId,
      topicId,
      scope: "group_topic",
    };
  }

  const senderMatch = conversationId.match(/^(.+):sender:([^:]+)$/i);
  if (senderMatch) {
    const [, chatId, senderOpenId] = senderMatch;
    return {
      canonicalConversationId: buildFeishuConversationId({
        chatId,
        scope: "group_sender",
        senderOpenId,
      }),
      chatId,
      senderOpenId,
      scope: "group_sender",
    };
  }

  if (parentConversationId) {
    return {
      canonicalConversationId: buildFeishuConversationId({
        chatId: parentConversationId,
        scope: "group_topic",
        topicId: conversationId,
      }),
      chatId: parentConversationId,
      topicId: conversationId,
      scope: "group_topic",
    };
  }

  return {
    canonicalConversationId: conversationId,
    chatId: conversationId,
    scope: "group",
  };
}

export function buildFeishuModelOverrideParentCandidates(
  parentConversationId?: string | null,
): string[] {
  const rawId = normalizeText(parentConversationId);
  if (!rawId) {
    return [];
  }
  const topicSenderMatch = rawId.match(/^(.+):topic:([^:]+):sender:([^:]+)$/i);
  if (topicSenderMatch) {
    const chatId = normalizeLowercaseStringOrEmpty(topicSenderMatch[1]);
    const topicId = normalizeLowercaseStringOrEmpty(topicSenderMatch[2]);
    if (chatId && topicId) {
      return [`${chatId}:topic:${topicId}`, chatId];
    }
    return [];
  }
  const topicMatch = rawId.match(/^(.+):topic:([^:]+)$/i);
  if (topicMatch) {
    const chatId = normalizeLowercaseStringOrEmpty(topicMatch[1]);
    return chatId ? [chatId] : [];
  }
  const senderMatch = rawId.match(/^(.+):sender:([^:]+)$/i);
  if (senderMatch) {
    const chatId = normalizeLowercaseStringOrEmpty(senderMatch[1]);
    return chatId ? [chatId] : [];
  }
  return [];
}

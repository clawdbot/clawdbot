// Feishu plugin module implements subagent hooks behavior.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildFeishuConversationId, parseFeishuConversationId } from "./conversation-id.js";
import { normalizeFeishuTarget, stripFeishuProviderPrefix } from "./targets.js";
import { getFeishuThreadBindingManager } from "./thread-bindings.js";

function resolveFeishuRequesterConversation(params: {
  accountId?: string;
  to?: string;
  threadId?: string | number;
  requesterSessionKey?: string;
}): {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
} | null {
  const manager = getFeishuThreadBindingManager(params.accountId);
  if (!manager) {
    return null;
  }
  const rawTo = params.to?.trim();
  const withoutProviderPrefix = rawTo ? stripFeishuProviderPrefix(rawTo) : "";
  const normalizedTarget = rawTo ? normalizeFeishuTarget(rawTo) : null;
  const threadId =
    params.threadId != null && params.threadId !== "" ? String(params.threadId).trim() : "";
  const isChatTarget = /^(chat|group|channel):/i.test(withoutProviderPrefix);
  const parsedRequesterTopic =
    normalizedTarget && threadId && isChatTarget
      ? parseFeishuConversationId({
          conversationId: buildFeishuConversationId({
            chatId: normalizedTarget,
            scope: "group_topic",
            topicId: threadId,
          }),
          parentConversationId: normalizedTarget,
        })
      : null;
  const requesterSessionKey = params.requesterSessionKey?.trim();
  if (requesterSessionKey) {
    const existingBindings = manager.listBySessionKey(requesterSessionKey);
    if (existingBindings.length === 1) {
      const existing = existingBindings.at(0);
      if (existing === undefined) {
        return null;
      }
      return {
        accountId: existing.accountId,
        conversationId: existing.conversationId,
        parentConversationId: existing.parentConversationId,
      };
    }
    if (existingBindings.length > 1) {
      if (rawTo && normalizedTarget && !threadId && !isChatTarget) {
        const directMatches = existingBindings.filter(
          (entry) =>
            entry.accountId === manager.accountId &&
            entry.conversationId === normalizedTarget &&
            !entry.parentConversationId,
        );
        if (directMatches.length === 1) {
          const existing = directMatches.at(0);
          if (existing === undefined) {
            return null;
          }
          return {
            accountId: existing.accountId,
            conversationId: existing.conversationId,
            parentConversationId: existing.parentConversationId,
          };
        }
        return null;
      }
      if (parsedRequesterTopic) {
        const matchingTopicBindings = existingBindings.filter((entry) => {
          const parsed = parseFeishuConversationId({
            conversationId: entry.conversationId,
            parentConversationId: entry.parentConversationId,
          });
          return (
            parsed?.chatId === parsedRequesterTopic.chatId &&
            parsed?.topicId === parsedRequesterTopic.topicId
          );
        });
        if (matchingTopicBindings.length === 1) {
          const existing = matchingTopicBindings.at(0);
          if (existing === undefined) {
            return null;
          }
          return {
            accountId: existing.accountId,
            conversationId: existing.conversationId,
            parentConversationId: existing.parentConversationId,
          };
        }
        const senderScopedTopicBindings = matchingTopicBindings.filter((entry) => {
          const parsed = parseFeishuConversationId({
            conversationId: entry.conversationId,
            parentConversationId: entry.parentConversationId,
          });
          return parsed?.scope === "group_topic_sender";
        });
        if (
          senderScopedTopicBindings.length === 1 &&
          matchingTopicBindings.length === senderScopedTopicBindings.length
        ) {
          const existing = senderScopedTopicBindings.at(0);
          if (existing === undefined) {
            return null;
          }
          return {
            accountId: existing.accountId,
            conversationId: existing.conversationId,
            parentConversationId: existing.parentConversationId,
          };
        }
        return null;
      }
    }
  }

  if (!rawTo) {
    return null;
  }
  if (!normalizedTarget) {
    return null;
  }

  if (threadId) {
    if (!isChatTarget) {
      return null;
    }
    return {
      accountId: manager.accountId,
      conversationId: buildFeishuConversationId({
        chatId: normalizedTarget,
        scope: "group_topic",
        topicId: threadId,
      }),
      parentConversationId: normalizedTarget,
    };
  }

  if (isChatTarget) {
    return null;
  }

  return {
    accountId: manager.accountId,
    conversationId: normalizedTarget,
  };
}

function resolveFeishuDeliveryOrigin(params: {
  conversationId: string;
  parentConversationId?: string;
  accountId: string;
  deliveryTo?: string;
  deliveryThreadId?: string;
}): {
  channel: "feishu";
  accountId: string;
  to: string;
  threadId?: string;
} {
  const deliveryTo = params.deliveryTo?.trim();
  const deliveryThreadId = params.deliveryThreadId?.trim();
  if (deliveryTo) {
    return {
      channel: "feishu",
      accountId: params.accountId,
      to: deliveryTo,
      ...(deliveryThreadId ? { threadId: deliveryThreadId } : {}),
    };
  }
  const parsed = parseFeishuConversationId({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (parsed?.topicId) {
    return {
      channel: "feishu",
      accountId: params.accountId,
      to: `chat:${params.parentConversationId?.trim() || parsed.chatId}`,
      threadId: parsed.topicId,
    };
  }
  return {
    channel: "feishu",
    accountId: params.accountId,
    to: `user:${params.conversationId}`,
  };
}

function resolveMatchingChildBinding(params: {
  accountId?: string;
  childSessionKey: string;
  requesterSessionKey?: string;
  requesterOrigin?: {
    to?: string;
    threadId?: string | number;
  };
}) {
  const manager = getFeishuThreadBindingManager(params.accountId);
  if (!manager) {
    return null;
  }
  const childBindings = manager.listBySessionKey(params.childSessionKey.trim());
  if (childBindings.length === 0) {
    return null;
  }

  const requesterConversation = resolveFeishuRequesterConversation({
    accountId: manager.accountId,
    to: params.requesterOrigin?.to,
    threadId: params.requesterOrigin?.threadId,
    requesterSessionKey: params.requesterSessionKey,
  });
  if (requesterConversation) {
    const matched = childBindings.find(
      (entry) =>
        entry.accountId === requesterConversation.accountId &&
        entry.conversationId === requesterConversation.conversationId &&
        normalizeOptionalString(entry.parentConversationId) ===
          normalizeOptionalString(requesterConversation.parentConversationId),
    );
    if (matched) {
      return matched;
    }
  }

  return childBindings.length === 1 ? childBindings[0] : null;
}

type FeishuSubagentDeliveryTargetEvent = {
  expectsCompletionMessage?: boolean;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  requesterSessionKey?: string;
};

type FeishuSubagentEndedEvent = {
  accountId?: string;
  targetSessionKey: string;
};

type FeishuSubagentDeliveryTargetResult =
  | {
      origin: {
        channel: "feishu";
        accountId?: string;
        to?: string;
        threadId?: string | number;
      };
    }
  | undefined;

export function handleFeishuSubagentDeliveryTarget(
  event: FeishuSubagentDeliveryTargetEvent,
): FeishuSubagentDeliveryTargetResult {
  if (!event.expectsCompletionMessage) {
    return undefined;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requesterOrigin?.channel);
  if (requesterChannel !== "feishu") {
    return undefined;
  }

  const binding = resolveMatchingChildBinding({
    accountId: event.requesterOrigin?.accountId,
    childSessionKey: event.childSessionKey,
    requesterSessionKey: event.requesterSessionKey,
    requesterOrigin: {
      to: event.requesterOrigin?.to,
      threadId: event.requesterOrigin?.threadId,
    },
  });
  if (!binding) {
    return undefined;
  }

  return {
    origin: resolveFeishuDeliveryOrigin({
      conversationId: binding.conversationId,
      parentConversationId: binding.parentConversationId,
      accountId: binding.accountId,
      deliveryTo: binding.deliveryTo,
      deliveryThreadId: binding.deliveryThreadId,
    }),
  };
}

export function handleFeishuSubagentEnded(event: FeishuSubagentEndedEvent) {
  const manager = getFeishuThreadBindingManager(event.accountId);
  manager?.unbindBySessionKey(event.targetSessionKey);
}

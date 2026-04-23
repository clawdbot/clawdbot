import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { buildFeishuConversationId, parseFeishuConversationId } from "./conversation-id.js";
import { normalizeFeishuTarget } from "./targets.js";
import { getFeishuThreadBindingManager } from "./thread-bindings.js";

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(feishu|lark):/i, "").trim();
}

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
  const withoutProviderPrefix = rawTo ? stripProviderPrefix(rawTo) : "";
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
      const existing = existingBindings[0];
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
          const existing = directMatches[0];
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
          const existing = matchingTopicBindings[0];
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
          const existing = senderScopedTopicBindings[0];
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

type FeishuSubagentContext = {
  requesterSessionKey?: string;
};

type FeishuSubagentSpawningEvent = {
  threadRequested?: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  agentId?: string;
  label?: string;
};

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

type FeishuSubagentSpawningResult =
  | { status: "ok"; threadBindingReady?: boolean }
  | { status: "error"; error: string }
  | undefined;

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

export async function handleFeishuSubagentSpawning(
  event: FeishuSubagentSpawningEvent,
  ctx: FeishuSubagentContext,
): Promise<FeishuSubagentSpawningResult> {
  if (!event.threadRequested) {
    return undefined;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requester?.channel);
  if (requesterChannel !== "feishu") {
    return undefined;
  }

  const manager = getFeishuThreadBindingManager(event.requester?.accountId);
  if (!manager) {
    return {
      status: "error" as const,
      error:
        "Feishu current-conversation binding is unavailable because the Feishu account monitor is not active.",
    };
  }

  const conversation = resolveFeishuRequesterConversation({
    accountId: event.requester?.accountId,
    to: event.requester?.to,
    threadId: event.requester?.threadId,
    requesterSessionKey: ctx.requesterSessionKey,
  });
  if (!conversation) {
    return {
      status: "error" as const,
      error:
        "Feishu current-conversation binding is only available in direct messages or topic conversations.",
    };
  }

  try {
    const binding = manager.bindConversation({
      conversationId: conversation.conversationId,
      parentConversationId: conversation.parentConversationId,
      targetKind: "subagent",
      targetSessionKey: event.childSessionKey,
      metadata: {
        agentId: event.agentId,
        label: event.label,
        boundBy: "system",
        deliveryTo: event.requester?.to,
        deliveryThreadId:
          event.requester?.threadId != null && event.requester.threadId !== ""
            ? String(event.requester.threadId)
            : undefined,
      },
    });
    if (!binding) {
      return {
        status: "error" as const,
        error:
          "Unable to bind this Feishu conversation to the spawned subagent session. Session mode is unavailable for this target.",
      };
    }
    return {
      status: "ok" as const,
      threadBindingReady: true,
    };
  } catch (err) {
    return {
      status: "error" as const,
      error: `Feishu conversation bind failed: ${summarizeError(err)}`,
    };
  }
}

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

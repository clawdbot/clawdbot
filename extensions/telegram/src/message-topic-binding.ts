// Telegram provider-owned authorization for message mutations in forum topics.
import { normalizeAccountId, normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-core";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type {
  ChannelMessageActionContext,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveDefaultTelegramAccountId } from "./accounts.js";
import {
  createTelegramMessageCache,
  hasProviderObservedTelegramThreadBinding,
  resolveTelegramMessageCacheScope,
} from "./message-cache.js";
import { parseTelegramTarget } from "./targets.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

export type TelegramMessageMutationContext = {
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  requesterAccountId?: string | null;
  toolContext?: ChannelThreadingToolContext;
};

const TOPIC_BINDING_ERROR =
  "Delegated Telegram message mutation requires a provider-observed binding to the exact current topic and account.";

function rejectUnboundTopicMutation(): never {
  throw new Error(TOPIC_BINDING_ERROR);
}

type CurrentTelegramConversation = {
  hasThreadContext: boolean;
  matchesChat: boolean;
  threadId?: number;
};

function resolveCurrentTelegramConversation(
  toolContext: ChannelThreadingToolContext | undefined,
  chatId: string,
): CurrentTelegramConversation {
  if (toolContext?.currentChannelProvider?.trim().toLowerCase() !== "telegram") {
    return { hasThreadContext: false, matchesChat: false };
  }
  const targets = [toolContext.currentChannelId, toolContext.currentMessagingTarget].filter(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  );
  const parsedTargets = targets.map((value) => parseTelegramTarget(value));
  const threadIds = [
    ...parsedTargets.map((target) => target.messageThreadId),
    parseStrictPositiveInteger(toolContext.currentThreadTs),
  ].filter((value): value is number => value !== undefined);
  const threadId = threadIds[0];
  const matchesChat =
    targets.length > 0 &&
    parsedTargets.every((target) => target.chatId === chatId) &&
    (threadId === undefined || threadIds.every((value) => value === threadId));
  return {
    hasThreadContext: threadIds.length > 0,
    matchesChat,
    ...(threadId !== undefined ? { threadId } : {}),
  };
}

export async function resolveTelegramMessageMutationChatId(params: {
  chatId: string | number;
  messageId: number;
  cfg: OpenClawConfig;
  accountId?: string | null;
  context?: TelegramMessageMutationContext;
}): Promise<string | number> {
  const target = parseTelegramTarget(String(params.chatId));
  if (params.context?.conversationReadOrigin === "direct-operator") {
    return target.messageThreadId === undefined ? params.chatId : target.chatId;
  }

  const currentConversation = resolveCurrentTelegramConversation(
    params.context?.toolContext,
    target.chatId,
  );
  const selectedAccountId = normalizeOptionalAccountId(
    params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
  );
  const requesterAccountId = normalizeOptionalAccountId(params.context?.requesterAccountId);
  if (
    !selectedAccountId ||
    !requesterAccountId ||
    normalizeAccountId(selectedAccountId) !== normalizeAccountId(requesterAccountId) ||
    !currentConversation.matchesChat
  ) {
    return rejectUnboundTopicMutation();
  }

  const threadId = target.messageThreadId ?? currentConversation.threadId;
  if (threadId === undefined && !currentConversation.hasThreadContext) {
    return target.chatId;
  }
  if (threadId === undefined || currentConversation.threadId !== threadId) {
    return rejectUnboundTopicMutation();
  }

  const currentMessageId = parseStrictPositiveInteger(
    params.context?.toolContext?.currentMessageId,
  );
  // Current-message context is server-owned. Earlier messages need the
  // persisted provider observation so a sibling topic cannot borrow the ID.
  if (currentMessageId === params.messageId) {
    return target.chatId;
  }

  const cache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(
      resolveStorePath(params.cfg.session?.store, {
        agentId: params.cfg.agents ? resolveDefaultAgentId(params.cfg) : "main",
      }),
    ),
  });
  const cached = await cache.get({
    accountId: selectedAccountId,
    chatId: target.chatId,
    messageId: String(params.messageId),
  });
  if (!hasProviderObservedTelegramThreadBinding(cached, threadId)) {
    return rejectUnboundTopicMutation();
  }
  return target.chatId;
}

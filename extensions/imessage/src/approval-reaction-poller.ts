// Imessage plugin module implements approval reaction poller behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  extractIMessageApprovalPromptBinding,
  handleIMessageApprovalReaction,
  listPendingIMessageApprovalReactionPollTargets,
  registerIMessageApprovalReactionTarget,
  type PendingIMessageApprovalReactionPollTarget,
  type IMessageApprovalConversationKey,
} from "./approval-reactions.js";
import type { IMessageRpcClient } from "./client.js";
import type { IMessagePayload } from "./monitor/types.js";

const RECENT_CHAT_LIMIT = 50;
const PER_CHAT_HISTORY_LIMIT = 30;
const OBSERVED_APPROVAL_PROMPT_TARGET_TTL_MS = 5 * 60 * 1000;

type ChatListEntry = {
  id?: number | null;
};

type HistoryMessage = IMessagePayload & {
  reactions?: Array<{
    id?: number | string | null;
    sender?: string | null;
    is_from_me?: boolean | null;
    type?: string | null;
    emoji?: string | null;
    created_at?: string | null;
  }> | null;
};

function normalizeChatId(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function listTargetChatIds(
  targets: readonly PendingIMessageApprovalReactionPollTarget[],
): number[] {
  const chatIds = new Set<number>();
  for (const target of targets) {
    const chatId = normalizeChatId(target.conversation.chatId);
    if (chatId !== null) {
      chatIds.add(chatId);
    }
  }
  return [...chatIds];
}

function hasUnscopedTarget(targets: readonly PendingIMessageApprovalReactionPollTarget[]): boolean {
  return targets.some((target) => normalizeChatId(target.conversation.chatId) === null);
}

function uniqueChatIds(chatIds: readonly number[]): number[] {
  return [...new Set(chatIds)];
}

function normalizeMessageGuid(value: string): string {
  return value.trim().replace(/^p:\d+\//iu, "");
}

function enumerateMessageGuidCandidates(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  const normalized = normalizeMessageGuid(trimmed);
  return [trimmed, normalized].filter(
    (candidate, index, candidates) =>
      candidate.length > 0 && candidates.indexOf(candidate) === index,
  );
}

function buildPendingTargetsByMessageId(
  targets: readonly PendingIMessageApprovalReactionPollTarget[],
): Map<string, PendingIMessageApprovalReactionPollTarget> {
  const pendingByMessageId = new Map<string, PendingIMessageApprovalReactionPollTarget>();
  for (const target of targets) {
    for (const candidate of enumerateMessageGuidCandidates(target.messageId)) {
      pendingByMessageId.set(candidate, target);
    }
  }
  return pendingByMessageId;
}

async function listRecentChatIds(client: IMessageRpcClient): Promise<number[]> {
  const result = await client.request<{ chats?: ChatListEntry[] }>(
    "chats.list",
    { limit: RECENT_CHAT_LIMIT },
    { timeoutMs: 10_000 },
  );
  return (result.chats ?? [])
    .map((chat) => normalizeChatId(chat.id))
    .filter((chatId): chatId is number => chatId !== null);
}

async function fetchRecentHistory(params: {
  client: IMessageRpcClient;
  chatId: number;
}): Promise<HistoryMessage[]> {
  const result = await params.client.request<{ messages?: unknown[] }>(
    "messages.history",
    {
      chat_id: params.chatId,
      limit: PER_CHAT_HISTORY_LIMIT,
    },
    { timeoutMs: 10_000 },
  );
  return (result.messages ?? []).filter((message): message is HistoryMessage =>
    Boolean(message && typeof message === "object"),
  );
}

function buildReactionPayload(params: {
  targetMessage: HistoryMessage;
  reaction: NonNullable<HistoryMessage["reactions"]>[number];
}): IMessagePayload | null {
  const emoji = params.reaction.emoji?.trim();
  const sender = params.reaction.sender?.trim();
  const targetGuid = params.targetMessage.guid?.trim();
  if (!emoji || !sender || !targetGuid) {
    return null;
  }
  const reactionId = normalizeChatId(params.reaction.id);
  return {
    ...(reactionId !== null ? { id: reactionId } : {}),
    guid: `reaction:${targetGuid}:${sender}:${emoji}:${params.reaction.created_at ?? ""}`,
    chat_id: params.targetMessage.chat_id,
    chat_guid: params.targetMessage.chat_guid,
    chat_identifier: params.targetMessage.chat_identifier,
    chat_name: params.targetMessage.chat_name,
    participants: params.targetMessage.participants,
    is_group: params.targetMessage.is_group,
    sender,
    destination_caller_id: params.targetMessage.destination_caller_id,
    is_from_me: params.reaction.is_from_me,
    text: `${params.reaction.type ?? "reaction"} "${params.targetMessage.text ?? ""}"`,
    created_at: params.reaction.created_at,
    is_reaction: true,
    is_tapback: true,
    associated_message_guid: targetGuid,
    associated_message_type: 2000,
    reaction_type: params.reaction.type ?? undefined,
    reaction_emoji: emoji,
    is_reaction_add: true,
    reacted_to_guid: targetGuid,
  };
}

function buildConversationKeyFromMessage(message: HistoryMessage): IMessageApprovalConversationKey {
  return {
    ...(message.chat_guid?.trim() ? { chatGuid: message.chat_guid.trim() } : {}),
    ...(message.chat_identifier?.trim() ? { chatIdentifier: message.chat_identifier.trim() } : {}),
    ...(normalizeChatId(message.chat_id) !== null ? { chatId: message.chat_id as number } : {}),
  };
}

function bindObservedConversation(params: {
  target: PendingIMessageApprovalReactionPollTarget;
  message: HistoryMessage;
}): void {
  const nowMs = asDateTimestampMs(Date.now());
  const expiresAtMs = asDateTimestampMs(params.target.expiresAtMs);
  if (nowMs === undefined || expiresAtMs === undefined || expiresAtMs <= nowMs) {
    return;
  }
  const ttlMs = expiresAtMs - nowMs;
  const conversation = buildConversationKeyFromMessage(params.message);
  const messageIds = new Set([
    ...enumerateMessageGuidCandidates(params.target.messageId),
    ...enumerateMessageGuidCandidates(params.message.guid ?? ""),
  ]);
  for (const messageId of messageIds) {
    registerIMessageApprovalReactionTarget({
      accountId: params.target.accountId,
      conversation,
      messageId,
      approvalId: params.target.approvalId,
      allowedDecisions: params.target.allowedDecisions,
      ttlMs,
    });
  }
}

function bindObservedApprovalPrompt(params: {
  accountId: string;
  message: HistoryMessage;
}): PendingIMessageApprovalReactionPollTarget | null {
  if (params.message.is_from_me !== true) {
    return null;
  }
  const messageId = params.message.guid?.trim();
  if (!messageId) {
    return null;
  }
  const binding = extractIMessageApprovalPromptBinding(params.message.text ?? "");
  if (!binding) {
    return null;
  }
  const conversation = buildConversationKeyFromMessage(params.message);
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(OBSERVED_APPROVAL_PROMPT_TARGET_TTL_MS);
  if (expiresAtMs === undefined) {
    return null;
  }
  const target: PendingIMessageApprovalReactionPollTarget = {
    accountId: params.accountId,
    conversation,
    messageId,
    approvalId: binding.approvalId,
    allowedDecisions: binding.allowedDecisions,
    expiresAtMs,
  };
  bindObservedConversation({ target, message: params.message });
  return target;
}

export async function pollPendingIMessageApprovalReactions(params: {
  client: IMessageRpcClient;
  cfg: OpenClawConfig;
  accountId: string;
  allowRecentChatDiscovery?: boolean;
  logVerboseMessage?: (message: string) => void;
}): Promise<void> {
  const targets = listPendingIMessageApprovalReactionPollTargets({
    accountId: params.accountId,
  });
  if (targets.length === 0 && params.allowRecentChatDiscovery !== true) {
    return;
  }

  const pendingByMessageId = buildPendingTargetsByMessageId(targets);
  const explicitChatIds = listTargetChatIds(targets);
  const shouldDiscoverRecentChats =
    params.allowRecentChatDiscovery === true &&
    (targets.length === 0 || hasUnscopedTarget(targets));
  const chatIds = shouldDiscoverRecentChats
    ? uniqueChatIds([...explicitChatIds, ...(await listRecentChatIds(params.client))])
    : explicitChatIds;
  if (chatIds.length === 0) {
    return;
  }
  for (const chatId of chatIds) {
    let messages: HistoryMessage[];
    try {
      messages = await fetchRecentHistory({ client: params.client, chatId });
    } catch (err) {
      params.logVerboseMessage?.(
        `imessage: approval reaction poll skipped chat_id=${chatId}: ${String(err)}`,
      );
      continue;
    }
    for (const message of messages) {
      const targetGuid = message.guid?.trim();
      if (!targetGuid) {
        continue;
      }
      const target =
        pendingByMessageId.get(targetGuid) ??
        pendingByMessageId.get(normalizeMessageGuid(targetGuid)) ??
        bindObservedApprovalPrompt({
          accountId: params.accountId,
          message,
        });
      if (!target) {
        continue;
      }
      bindObservedConversation({ target, message });
      for (const reaction of message.reactions ?? []) {
        const reactionPayload = buildReactionPayload({ targetMessage: message, reaction });
        if (!reactionPayload) {
          continue;
        }
        const handled = await handleIMessageApprovalReaction({
          cfg: params.cfg,
          accountId: params.accountId,
          message: reactionPayload,
          bodyText: reactionPayload.text ?? "",
          logVerboseMessage: params.logVerboseMessage,
        });
        if (handled.stopPolling) {
          return;
        }
      }
    }
  }
}

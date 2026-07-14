// Telegram reply-chain cache and prompt-context projection.
import type { Message } from "grammy/types";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import { stripInlineDirectiveTagsForDelivery } from "openclaw/plugin-sdk/text-chunking";
import type { TelegramMessageSessionRuntime } from "./bot-handlers.message-session.runtime.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type {
  TelegramMessageContextOptions,
  TelegramPromptContextEntry,
} from "./bot-message-context.types.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import { getTelegramTextParts, resolveTelegramBotHasTopicsEnabled } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import {
  buildTelegramSelfSenderName,
  isTelegramHistoryEntryAfterAmbientWatermark,
  isTelegramSelfSenderName,
} from "./group-history-window.js";
import {
  buildTelegramConversationContext,
  buildTelegramReplyChain,
  createTelegramMessageCache,
  isTelegramMessageFromCurrentBot,
  isTelegramSessionBoundaryCommandText,
  resolveTelegramMessageCacheScope,
  type TelegramCachedMessageNode,
  type TelegramReplyChainEntry,
} from "./message-cache.js";
import { resolveCompleteTelegramPromptContextProjectionIds } from "./prompt-context-projection.js";
import { buildTelegramSessionTranscriptPromptEntries } from "./session-transcript-context.js";

function hasLegacyPromptContextTimestamp(
  node: TelegramCachedMessageNode,
  botUserId?: number,
): boolean {
  if (node.promptContextProjectionMarker) {
    return false;
  }
  const timestamp = (
    node.sourceMessage as Message & { openclaw_prompt_context_timestamp_ms?: unknown }
  ).openclaw_prompt_context_timestamp_ms;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return false;
  }
  // Shipped previews created before bot identity was available used id 0. The
  // private timestamp marker is their durable outbound provenance.
  return (
    isTelegramMessageFromCurrentBot(node.sourceMessage, botUserId) ||
    (node.sourceMessage.from?.id === 0 && node.sourceMessage.from.is_bot)
  );
}

function resolvePromptContextTextDedupeKey(message: {
  body?: unknown;
  timestamp_ms?: unknown;
}): string | undefined {
  if (typeof message.body !== "string") {
    return undefined;
  }
  const visibleBody = stripInlineDirectiveTagsForDelivery(message.body).text.trim();
  if (!visibleBody) {
    return undefined;
  }
  if (typeof message.timestamp_ms !== "number" || !Number.isFinite(message.timestamp_ms)) {
    return undefined;
  }
  return `${message.timestamp_ms}:${visibleBody}`;
}

export type TelegramPromptContextMessageSelection = ReadonlyMap<string, "include" | "exclude">;

export function createTelegramMessageContextRuntime(
  {
    cfg,
    accountId,
    opts,
    telegramCfg,
    telegramDeps,
  }: Pick<
    RegisterTelegramHandlerParams,
    "cfg" | "accountId" | "opts" | "telegramCfg" | "telegramDeps"
  >,
  { resolveTelegramSessionState }: TelegramMessageSessionRuntime,
) {
  const messageCache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(telegramDeps.resolveStorePath(cfg.session?.store)),
  });
  const resolvePromptSender = (
    node: TelegramCachedMessageNode,
    ctx: TelegramContext,
  ): string | undefined => {
    const botInfo = ctx.me ?? opts.botInfo;
    // Business replies keep the account user in `from`; Telegram authenticates the bot separately.
    const isAuthenticatedSelf =
      botInfo?.id != null &&
      (node.senderId === String(botInfo.id) ||
        node.sourceMessage.sender_business_bot?.id === botInfo.id);
    if (isAuthenticatedSelf) {
      return buildTelegramSelfSenderName(telegramCfg.name, botInfo);
    }
    if (node.senderId === "0" && node.sourceMessage.from?.is_bot === true) {
      return node.sender;
    }
    return isTelegramSelfSenderName(node.sender) ? `${node.sender} (Telegram sender)` : node.sender;
  };

  const recordMessageForReplyChain = (msg: Message, threadId?: number, botUserId?: number) =>
    messageCache.record({
      accountId,
      chatId: msg.chat.id,
      msg,
      ...(botUserId !== undefined ? { botUserId } : {}),
      ...(threadId != null ? { threadId } : {}),
    });

  const buildReplyChainForMessage = (msg: Message) =>
    buildTelegramReplyChain({ cache: messageCache, accountId, chatId: msg.chat.id, msg });

  const toReplyChainEntry = (
    node: TelegramCachedMessageNode,
    ctx: TelegramContext,
    media?: TelegramMediaRef,
  ): TelegramReplyChainEntry => {
    const {
      sourceMessage: _sourceMessage,
      promptContextProjectionMarker: _promptContextProjectionMarker,
      ...entry
    } = node;
    const projectedEntry = { ...entry, sender: resolvePromptSender(node, ctx) };
    if (!media?.path) {
      return projectedEntry;
    }
    const { mediaRef: _mediaRef, ...entryWithoutProviderMediaRef } = projectedEntry;
    return {
      ...entryWithoutProviderMediaRef,
      mediaPath: media.path,
      ...(media.contentType ? { mediaType: media.contentType } : {}),
    };
  };

  const toPromptContextMessage = (
    node: TelegramCachedMessageNode,
    ctx: TelegramContext,
    flags?: { replyTarget?: boolean },
    media?: TelegramMediaRef,
  ) => ({
    message_id: node.messageId,
    thread_id: node.threadId,
    sender: resolvePromptSender(node, ctx),
    sender_id: node.senderId,
    sender_username: node.senderUsername,
    timestamp_ms: node.timestamp,
    body: node.body,
    media_type: media?.contentType ?? node.mediaType,
    media_path: media?.path,
    media_ref: media?.path ? undefined : node.mediaRef,
    reply_to_id: node.replyToId,
    is_reply_target: flags?.replyTarget === true ? true : undefined,
  });

  const buildPromptContextForMessage = async (
    ctx: TelegramContext,
    msg: Message,
    replyChainNodes: TelegramCachedMessageNode[],
    runtimeCfg: OpenClawConfig,
    runtimeTelegramCfg: TelegramAccountConfig,
    options?: TelegramMessageContextOptions,
    mediaByMessageId?: ReadonlyMap<string, TelegramMediaRef>,
    selectedMessageIds?: TelegramPromptContextMessageSelection,
  ): Promise<TelegramPromptContextEntry[]> => {
    const currentBotUserId = ctx.me?.id ?? opts.botInfo?.id;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const groupHistoryLimit = Math.max(
      0,
      runtimeTelegramCfg.historyLimit ??
        runtimeCfg.messages?.groupChat?.historyLimit ??
        DEFAULT_GROUP_HISTORY_LIMIT,
    );
    const messageId = typeof msg.message_id === "number" ? String(msg.message_id) : undefined;
    const currentNode = await messageCache.get({ accountId, chatId: msg.chat.id, messageId });
    const threadId = currentNode?.threadId ? Number(currentNode.threadId) : undefined;
    const sessionBeforeTimestampMs =
      options?.receivedAtMs ?? (msg.date ? msg.date * 1000 : undefined);
    const isSessionBoundaryMessage = isTelegramSessionBoundaryCommandText(
      getTelegramTextParts(msg).text,
    );
    const sessionPromptEntries =
      isGroup || isSessionBoundaryMessage
        ? []
        : await buildTelegramSessionTranscriptPromptEntries({
            ...resolveTelegramSessionState({
              chatId: msg.chat.id,
              isGroup: false,
              isForum: false,
              messageThreadId: msg.message_thread_id,
              botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
              senderId: msg.from?.id,
              runtimeCfg,
            }),
            limit: 10,
            ...(sessionBeforeTimestampMs !== undefined
              ? { beforeTimestampMs: sessionBeforeTimestampMs }
              : {}),
            ...(options?.promptContextMinTimestampMs !== undefined
              ? { minTimestampMs: options.promptContextMinTimestampMs }
              : {}),
          });
    const conversationContext =
      isGroup && groupHistoryLimit <= 0
        ? []
        : await buildTelegramConversationContext({
            cache: messageCache,
            messageId,
            accountId,
            chatId: msg.chat.id,
            ...(Number.isFinite(threadId) ? { threadId } : {}),
            replyChainNodes,
            recentLimit: isGroup ? groupHistoryLimit : 10,
            replyTargetWindowSize: 2,
            ...(options?.promptContextMinTimestampMs !== undefined
              ? { minTimestampMs: options.promptContextMinTimestampMs }
              : {}),
            ...(isGroup && options?.promptContextAmbientWatermark !== undefined
              ? {
                  includeNode: (
                    node: TelegramCachedMessageNode,
                    flags?: { replyTarget?: boolean },
                  ) =>
                    flags?.replyTarget === true ||
                    isTelegramHistoryEntryAfterAmbientWatermark(
                      node,
                      options.promptContextAmbientWatermark,
                    ),
                }
              : {}),
          });
    const conversationContextById = new Map(
      conversationContext.flatMap((entry) =>
        entry.node.messageId ? [[entry.node.messageId, entry] as const] : [],
      ),
    );
    for (const [selectedMessageId, selection] of selectedMessageIds ?? []) {
      if (selection === "exclude") {
        conversationContextById.delete(selectedMessageId);
        continue;
      }
      if (selectedMessageId === messageId || conversationContextById.has(selectedMessageId)) {
        continue;
      }
      const node = await messageCache.get({
        accountId,
        chatId: msg.chat.id,
        messageId: selectedMessageId,
      });
      if (node?.messageId) {
        conversationContextById.set(node.messageId, { node });
      }
    }
    const cacheEntries = Array.from(conversationContextById.values()).map((entry) => ({
      node: entry.node,
      message: toPromptContextMessage(
        entry.node,
        ctx,
        { replyTarget: entry.isReplyTarget },
        entry.node.messageId ? mediaByMessageId?.get(entry.node.messageId) : undefined,
      ),
    }));
    const cacheMessages = cacheEntries.map((entry) => entry.message);
    const inboundTextKeys = new Set<string>();
    const legacyOutboundTextKeys = new Set<string>();
    for (const entry of cacheEntries) {
      const key = resolvePromptContextTextDedupeKey(entry.message);
      if (key === undefined) {
        continue;
      }
      if (hasLegacyPromptContextTimestamp(entry.node, currentBotUserId)) {
        legacyOutboundTextKeys.add(key);
      } else if (!isTelegramMessageFromCurrentBot(entry.node.sourceMessage, currentBotUserId)) {
        inboundTextKeys.add(key);
      }
    }
    const completeProjectionIds = resolveCompleteTelegramPromptContextProjectionIds(
      cacheEntries.map((entry) => entry.node.promptContextProjectionMarker),
    );
    const sessionOnlyMessages = sessionPromptEntries.flatMap((entry) => {
      if (entry.role === "assistant") {
        if (entry.transcriptMessageId && completeProjectionIds.has(entry.transcriptMessageId)) {
          return [];
        }
        const key = resolvePromptContextTextDedupeKey(entry.message);
        return key !== undefined && legacyOutboundTextKeys.has(key) ? [] : [entry.message];
      }
      const key = resolvePromptContextTextDedupeKey(entry.message);
      return key !== undefined && inboundTextKeys.has(key) ? [] : [entry.message];
    });
    const promptMessages = [...sessionOnlyMessages, ...cacheMessages].toSorted(
      (left, right) => (left.timestamp_ms ?? 0) - (right.timestamp_ms ?? 0),
    );
    return promptMessages.length > 0
      ? [
          {
            label: "Conversation context",
            source: sessionOnlyMessages.length > 0 ? "session" : "telegram",
            type: "chat_window",
            payload: {
              order: "chronological",
              relation: "selected_for_current_message",
              messages: promptMessages,
            },
          },
        ]
      : [];
  };

  return {
    recordMessageForReplyChain,
    buildReplyChainForMessage,
    toReplyChainEntry,
    buildPromptContextForMessage,
  };
}

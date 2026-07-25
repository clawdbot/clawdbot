// Telegram reply-chain cache and prompt-context projection.
import type { Message } from "grammy/types";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import { stripInlineDirectiveTagsForDelivery } from "openclaw/plugin-sdk/text-chunking";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type {
  TelegramMessageContextOptions,
  TelegramPromptContextEntry,
} from "./bot-message-context.types.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
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
  resolveTelegramMessageCacheScope,
  type TelegramCachedMessageNode,
  type TelegramReplyChainEntry,
} from "./message-cache.js";
import { resolveCompleteTelegramPromptContextProjectionIds } from "./prompt-context-projection.js";

function legacyAssistantTextKey(node: TelegramCachedMessageNode, botUserId?: number) {
  if (node.promptContextProjectionMarker) {
    return undefined;
  }
  const timestamp = (
    node.sourceMessage as Message & { openclaw_prompt_context_timestamp_ms?: unknown }
  ).openclaw_prompt_context_timestamp_ms;
  const legacySelf =
    isTelegramMessageFromCurrentBot(node.sourceMessage, botUserId) ||
    (node.sourceMessage.from?.id === 0 && node.sourceMessage.from.is_bot);
  const body = stripInlineDirectiveTagsForDelivery(node.body ?? "").text.trim();
  return legacySelf && typeof timestamp === "number" && body
    ? `text:${timestamp}:${body}`
    : undefined;
}

export type TelegramPromptContextMessageSelection = ReadonlyMap<string, "include" | "exclude">;

export function createTelegramMessageContextRuntime({
  cfg,
  accountId,
  opts,
  telegramCfg,
  telegramDeps,
}: Pick<
  RegisterTelegramHandlerParams,
  "cfg" | "accountId" | "opts" | "telegramCfg" | "telegramDeps"
>) {
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
      ...(threadId != null ? { providerObservedThreadId: threadId } : {}),
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
      threadBinding: _threadBinding,
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
      mediaKind: media.kind,
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
    media_type: media?.contentType ?? media?.kind ?? node.mediaType,
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
    const completeProjectionIds = resolveCompleteTelegramPromptContextProjectionIds(
      cacheEntries.map((entry) => entry.node.promptContextProjectionMarker),
    );
    const legacyAssistantTextKeys = cacheEntries.flatMap(({ node }) => {
      const key = legacyAssistantTextKey(node, ctx.me?.id ?? opts.botInfo?.id);
      return key ? [key] : [];
    });
    const messages = cacheEntries.map((entry) => entry.message);
    return messages.length > 0
      ? [
          {
            label: "Conversation context",
            source: "telegram",
            type: "chat_window",
            ...(completeProjectionIds.size > 0
              ? { sessionTranscriptDedupeMessageIds: [...completeProjectionIds] }
              : {}),
            ...(legacyAssistantTextKeys.length > 0
              ? { sessionTranscriptAssistantTextDedupeKeys: legacyAssistantTextKeys }
              : {}),
            payload: {
              order: "chronological",
              relation: "selected_for_current_message",
              messages,
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

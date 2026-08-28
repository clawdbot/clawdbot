import type { Message } from "grammy/types";
import { formatMediaPlaceholderText } from "openclaw/plugin-sdk/channel-inbound";
import { resolveStoredModelOverride } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import {
  getSessionEntry,
  readAmbientTranscriptWatermark,
  resolveAmbientTranscriptWatermarkKey,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { asFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";
import { stripInlineDirectiveTagsForDelivery } from "openclaw/plugin-sdk/text-chunking";
import { resolveDefaultModelForAgent } from "./bot-handlers.agent.runtime.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type {
  TelegramAmbientTranscriptWatermark,
  TelegramMessageContextOptions,
  TelegramPromptContextEntry,
} from "./bot-message-context.types.js";
import {
  buildSenderName,
  getTelegramTextParts,
  resolveTelegramPrimaryMedia,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import {
  resolveTelegramConversationRoute,
  resolveTelegramTargetSession,
} from "./conversation-route.js";
import { resolveTelegramDmHistoryLimit } from "./dm-history.js";
import {
  buildTelegramSelfSenderName,
  isTelegramHistoryEntryAfterAmbientWatermark,
  isTelegramSelfSenderName,
} from "./group-history-window.js";
import {
  resolveTelegramMessageCacheScope,
  type TelegramResolvedMedia,
} from "./message-cache-persistence.js";
import {
  buildTelegramConversationContext,
  buildTelegramReplyChain,
  createTelegramMessageCache,
  isTelegramMessageFromCurrentBot,
  resolveProviderObservedTelegramThreadSpec,
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

export type TelegramSessionState = {
  agentId: string;
  sessionEntry: SessionEntry | undefined;
  sessionKey: string;
  storePath: string;
  model: string | undefined;
};

export type ResolveTelegramSessionStateParams = {
  chatId: number | string;
  isGroup: boolean;
  threadSpec: TelegramThreadSpec;
  botHasTopicsEnabled?: boolean;
  senderId?: string | number;
  runtimeCfg: OpenClawConfig;
};

export type ResolvePromptContextAmbientWatermarkParams = {
  chatId: number | string;
  isGroup: boolean;
  resolvedThreadId?: number;
  sessionKey: string;
  storePath: string;
};

export const normalizePromptContextMinTimestampMs = (timestampMs?: number) =>
  asFiniteNumber(timestampMs);

export function promptContextBoundaryOptions(
  timestampMs?: number,
  ambientWatermark?: TelegramAmbientTranscriptWatermark,
): Pick<
  TelegramMessageContextOptions,
  "promptContextMinTimestampMs" | "promptContextAmbientWatermark"
> {
  const promptContextMinTimestampMs = normalizePromptContextMinTimestampMs(timestampMs);
  return {
    ...(promptContextMinTimestampMs === undefined ? {} : { promptContextMinTimestampMs }),
    ...(ambientWatermark === undefined ? {} : { promptContextAmbientWatermark: ambientWatermark }),
  };
}

export function latestPromptContextMinTimestampMs(
  ...timestamps: Array<number | undefined>
): number | undefined {
  let latest: number | undefined;
  for (const timestampMs of timestamps) {
    const normalized = normalizePromptContextMinTimestampMs(timestampMs);
    if (normalized !== undefined) {
      latest = latest === undefined ? normalized : Math.max(latest, normalized);
    }
  }
  return latest;
}

export const latestPromptContextAmbientWatermark = (
  ...watermarks: Array<TelegramAmbientTranscriptWatermark | undefined>
): TelegramAmbientTranscriptWatermark | undefined =>
  watermarks.findLast((watermark) => watermark !== undefined);

export function buildSyntheticTextMessage(params: {
  base: Message.ServiceMessage;
  text: string;
  entities?: Message["entities"];
  date?: number;
  from?: Message["from"];
}): Message {
  return {
    ...params.base,
    ...(params.from ? { from: params.from } : {}),
    text: params.text,
    caption: undefined,
    caption_entities: undefined,
    entities: params.entities?.length ? params.entities : undefined,
    ...(params.date != null ? { date: params.date } : {}),
  };
}

export const buildSyntheticContext = (
  ctx: Pick<TelegramContext, "me" | "getFile" | "update">,
  message: Message,
): TelegramContext => ({
  message,
  update: ctx.update,
  me: ctx.me,
  getFile: ctx.getFile.bind(ctx),
});

export function formatTelegramAmbientTranscriptBody(
  messages: readonly Message[],
): string | undefined {
  const lines = messages.map((msg) => {
    const text = getTelegramTextParts(msg).text.trim();
    const media = resolveTelegramPrimaryMedia(msg);
    const body = text || formatMediaPlaceholderText(media ? [{ kind: media.kind }] : [{}]);
    const messageId = msg.message_id ? `#${msg.message_id}` : undefined;
    const sender = buildSenderName(msg);
    const prefix = [messageId, sender].filter(Boolean).join(" ");
    return prefix ? `${prefix}: ${body}` : body;
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function createTelegramMessageSessionRuntime({
  accountId,
  resolveTelegramGroupConfig,
  telegramDeps,
}: Pick<
  RegisterTelegramHandlerParams,
  "accountId" | "resolveTelegramGroupConfig" | "telegramDeps"
>) {
  const loadSessionEntry = telegramDeps.getSessionEntry ?? getSessionEntry;
  const resolveTelegramSessionState = (
    params: ResolveTelegramSessionStateParams,
  ): TelegramSessionState => {
    const dmThreadId = params.threadSpec.scope === "dm" ? params.threadSpec.id : undefined;
    const topicThreadId = params.threadSpec.id;
    const { topicConfig } = resolveTelegramGroupConfig(
      params.chatId,
      topicThreadId,
      params.runtimeCfg,
    );
    const { route } = resolveTelegramConversationRoute({
      cfg: params.runtimeCfg,
      accountId,
      chatId: params.chatId,
      isGroup: params.isGroup,
      threadSpec: params.threadSpec,
      senderId: params.senderId,
      topicAgentId: topicConfig?.agentId,
    });
    const sessionKey = resolveTelegramTargetSession({
      cfg: params.runtimeCfg,
      route,
      chatId: params.chatId,
      isGroup: params.isGroup,
      senderId: params.senderId,
      dmThreadId,
      botHasTopicsEnabled: params.botHasTopicsEnabled,
    });
    const storePath = telegramDeps.resolveStorePath(params.runtimeCfg.session?.store, {
      agentId: route.agentId,
    });
    const entry = loadSessionEntry({ storePath, sessionKey });
    const storedOverride = resolveStoredModelOverride({
      sessionEntry: entry,
      loadSessionEntry: (parentSessionKey) =>
        loadSessionEntry({ storePath, sessionKey: parentSessionKey }),
      sessionKey,
      defaultProvider: resolveDefaultModelForAgent({
        cfg: params.runtimeCfg,
        agentId: route.agentId,
      }).provider,
    });
    if (storedOverride) {
      return {
        agentId: route.agentId,
        sessionEntry: entry,
        sessionKey,
        storePath,
        model: storedOverride.provider
          ? `${storedOverride.provider}/${storedOverride.model}`
          : storedOverride.model,
      };
    }
    const provider = entry?.modelProvider?.trim();
    const model = entry?.model?.trim();
    if (provider && model) {
      return {
        agentId: route.agentId,
        sessionEntry: entry,
        sessionKey,
        storePath,
        model: `${provider}/${model}`,
      };
    }
    const modelCfg = params.runtimeCfg.agents?.defaults?.model;
    return {
      agentId: route.agentId,
      sessionEntry: entry,
      sessionKey,
      storePath,
      model: typeof modelCfg === "string" ? modelCfg : modelCfg?.primary,
    };
  };

  const resolvePromptContextAmbientWatermark = (
    params: ResolvePromptContextAmbientWatermarkParams,
  ): TelegramAmbientTranscriptWatermark | undefined => {
    if (!params.isGroup) {
      return undefined;
    }
    const key = (
      telegramDeps.resolveAmbientTranscriptWatermarkKey ?? resolveAmbientTranscriptWatermarkKey
    )({
      channel: "telegram",
      accountId,
      conversationId: String(params.chatId),
      ...(params.resolvedThreadId !== undefined ? { threadId: params.resolvedThreadId } : {}),
    });
    return (telegramDeps.readAmbientTranscriptWatermark ?? readAmbientTranscriptWatermark)({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      key,
    });
  };

  return { resolveTelegramSessionState, resolvePromptContextAmbientWatermark };
}

export function createTelegramMessageContextRuntime({
  cfg,
  accountId,
  ownerAgentId,
  opts,
  telegramCfg,
  telegramDeps,
}: Pick<
  RegisterTelegramHandlerParams,
  "cfg" | "accountId" | "ownerAgentId" | "opts" | "telegramCfg" | "telegramDeps"
>) {
  const messageCache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(
      telegramDeps.resolveStorePath(cfg.session?.store, {
        agentId: ownerAgentId,
      }),
    ),
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

  const recordMessageForReplyChain = (
    msg: Message,
    providerObservedThread?: TelegramThreadSpec,
    botUserId?: number,
  ) =>
    messageCache.record({
      accountId,
      chatId: msg.chat.id,
      msg,
      ...(botUserId !== undefined ? { botUserId } : {}),
      ...(providerObservedThread ? { providerObservedThread } : {}),
      ...(providerObservedThread?.id != null ? { threadId: providerObservedThread.id } : {}),
    });

  const recordMessageResolvedMedia = (params: {
    msg: Message;
    media: TelegramResolvedMedia;
    botUserId?: number;
  }) =>
    messageCache.recordResolvedMedia({
      accountId,
      chatId: params.msg.chat.id,
      messageId: String(params.msg.message_id),
      media: params.media,
      ...(params.botUserId !== undefined ? { botUserId: params.botUserId } : {}),
    });

  const recordReplyMessageResolvedMedia = async (params: {
    chatId: string | number;
    messageId: string;
    media: TelegramResolvedMedia;
    botUserId?: number;
  }) => {
    const cachedNode = await messageCache.get({
      accountId,
      chatId: params.chatId,
      messageId: params.messageId,
    });
    if (!cachedNode) {
      return;
    }
    await messageCache.recordResolvedMedia({
      accountId,
      chatId: params.chatId,
      messageId: params.messageId,
      media: params.media,
      ...(params.botUserId !== undefined ? { botUserId: params.botUserId } : {}),
    });
  };

  // `MessageReactionUpdated` carries no `message_thread_id`, so the reaction handler
  // recovers the originating topic from the same bounded cache that records inbound
  // and outbound messages. `undefined` means "thread unknown", never "General": the
  // caller must not substitute a topic id.
  const resolveCachedMessageThreadSpec = async (params: {
    chatId: number | string;
    messageId: number | string;
  }): Promise<TelegramThreadSpec | undefined> => {
    const node = await messageCache.get({
      accountId,
      chatId: params.chatId,
      messageId: String(params.messageId),
    });
    return resolveProviderObservedTelegramThreadSpec(node);
  };

  const buildReplyChainForMessage = (msg: Message) =>
    buildTelegramReplyChain({ cache: messageCache, accountId, chatId: msg.chat.id, msg });

  const toReplyChainEntry = (
    node: TelegramCachedMessageNode,
    ctx: TelegramContext,
    media?: TelegramMediaRef,
  ): TelegramReplyChainEntry => {
    const {
      sourceMessage: _sourceMessage,
      resolvedMedia: _resolvedMedia,
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
    const dmHistoryLimit = resolveTelegramDmHistoryLimit({
      config: runtimeTelegramCfg,
      senderId: msg.from?.id,
    });
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
            recentLimit: isGroup ? groupHistoryLimit : dmHistoryLimit,
            replyTargetWindowSize: isGroup || dmHistoryLimit > 0 ? 2 : 0,
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
    recordMessageResolvedMedia,
    recordReplyMessageResolvedMedia,
    resolveCachedMessageThreadSpec,
    buildReplyChainForMessage,
    toReplyChainEntry,
    buildPromptContextForMessage,
  };
}

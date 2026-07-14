// Telegram message-like update registration and cache/dispatch ordering.
import type { Message } from "grammy/types";
import type { TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { TelegramHandlerAuthorizationRuntime } from "./bot-handlers.authorization.runtime.js";
import type { TelegramHandlerInboundRuntime } from "./bot-handlers.inbound.runtime.js";
import type { TelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";
import {
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramForumFlag,
  withResolvedTelegramForumFlag,
} from "./bot/helpers.js";
import { TelegramPairingStoreReadError } from "./bot/helpers.js";
import type { TelegramContext, TelegramGetChat } from "./bot/types.js";

export function registerTelegramMessageHandlers(
  { bot, opts, runtime, shouldSkipUpdate }: RegisterTelegramHandlerParams,
  messageRuntime: TelegramHandlerMessageRuntime,
  authorizationRuntime: TelegramHandlerAuthorizationRuntime,
  inboundRuntime: TelegramHandlerInboundRuntime,
) {
  const {
    normalizePromptContextMinTimestampMs,
    promptContextBoundaryOptions,
    releaseDispatchDedupeKeys,
    claimMessageDispatchDedupe,
    buildSyntheticContext,
    resolveTelegramSessionState,
    resolvePromptContextAmbientWatermark,
    recordMessageForReplyChain,
  } = messageRuntime;
  const { authorizeInboundMessage } = authorizationRuntime;
  const { processInboundMessage } = inboundRuntime;
  const getChat: TelegramGetChat = bot.api.getChat.bind(bot.api);
  type InboundTelegramEvent = {
    ctxForDedupe: TelegramUpdateKeyContext;
    ctx: TelegramContext;
    msg: Message;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    senderId: string;
    senderUsername: string;
    requireConfiguredGroup: boolean;
    sendOversizeWarning: boolean;
    oversizeLogMessage: string;
    errorMessage: string;
  };

  const normalizeChannelPostMessage = (post: Message): Message => {
    const chatId = post.chat.id;
    const syntheticFrom = post.sender_chat
      ? {
          id: post.sender_chat.id,
          is_bot: true as const,
          first_name: post.sender_chat.title || "Channel",
          username: post.sender_chat.username,
        }
      : {
          id: chatId,
          is_bot: true as const,
          first_name: post.chat.title || "Channel",
          username: post.chat.username,
        };
    return {
      ...post,
      from: post.from ?? syntheticFrom,
      chat: {
        ...post.chat,
        type: "supergroup" as const,
      },
    } as Message;
  };
  const recordEditedMessageForReplyChain = async (params: {
    ctxForDedupe: TelegramUpdateKeyContext;
    msg: Message;
    requireConfiguredGroup: boolean;
    botUserId?: number;
  }) => {
    if (shouldSkipUpdate(params.ctxForDedupe)) {
      return;
    }
    const msg = params.msg;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isForum = await resolveTelegramForumFlag({
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      isGroup,
      isForum: msg.chat.is_forum,
      isTopicMessage: msg.is_topic_message,
      getChat,
    });
    const normalizedMsg = withResolvedTelegramForumFlag(msg, isForum);
    const gate = await authorizeInboundMessage({
      msg: normalizedMsg,
      chatId: normalizedMsg.chat.id,
      isGroup,
      isForum,
      messageThreadId: normalizedMsg.message_thread_id,
      senderId: normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "",
      senderUsername: normalizedMsg.from?.username ?? "",
      requireConfiguredGroup: params.requireConfiguredGroup,
      dmAccess: "silent",
    });
    if (!gate.allowed) {
      return;
    }
    const { resolvedThreadId, dmThreadId } = gate.context;
    await recordMessageForReplyChain(
      normalizedMsg,
      resolvedThreadId ?? dmThreadId,
      params.botUserId,
    );
  };

  const handleInboundMessageLike = async (event: InboundTelegramEvent) => {
    let dispatchDedupeKeys: string[] = [];
    try {
      if (shouldSkipUpdate(event.ctxForDedupe)) {
        return;
      }
      const gate = await authorizeInboundMessage({
        msg: event.msg,
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        messageThreadId: event.messageThreadId,
        senderId: event.senderId,
        senderUsername: event.senderUsername,
        requireConfiguredGroup: event.requireConfiguredGroup,
        dmAccess: "challenge",
      });
      if (!gate.allowed) {
        return;
      }
      const { effectiveDmAllow } = gate;
      const {
        dmPolicy,
        resolvedThreadId,
        dmThreadId,
        storeAllowFrom,
        groupConfig,
        topicConfig,
        effectiveGroupAllow,
      } = gate.context;

      const sessionState = resolveTelegramSessionState({
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        messageThreadId: event.messageThreadId,
        resolvedThreadId,
        botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(event.ctx.me),
        senderId: event.senderId,
        runtimeCfg: gate.context.cfg,
      });
      const promptContextMinTimestampMs = normalizePromptContextMinTimestampMs(
        sessionState.sessionEntry?.sessionStartedAt,
      );
      const promptContextAmbientWatermark = resolvePromptContextAmbientWatermark({
        chatId: event.chatId,
        isGroup: event.isGroup,
        resolvedThreadId,
        sessionKey: sessionState.sessionKey,
        storePath: sessionState.storePath,
      });

      const dispatchDedupe = await claimMessageDispatchDedupe(event.msg);
      if (!dispatchDedupe.process) {
        return;
      }
      dispatchDedupeKeys = dispatchDedupe.keys;
      await recordMessageForReplyChain(
        event.msg,
        resolvedThreadId ?? dmThreadId,
        event.ctx.me?.id ?? opts.botInfo?.id,
      );
      await processInboundMessage({
        authorizationCfg: gate.context.cfg,
        ctx: event.ctx,
        msg: event.msg,
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        resolvedThreadId,
        dmThreadId,
        dmPolicy,
        storeAllowFrom,
        senderId: event.senderId,
        effectiveGroupAllow,
        effectiveDmAllow,
        groupConfig: event.isGroup ? (groupConfig as TelegramGroupConfig | undefined) : undefined,
        topicConfig,
        sendOversizeWarning: event.sendOversizeWarning,
        oversizeLogMessage: event.oversizeLogMessage,
        dispatchDedupeKeys,
        ...promptContextBoundaryOptions(promptContextMinTimestampMs, promptContextAmbientWatermark),
      });
    } catch (err) {
      releaseDispatchDedupeKeys(dispatchDedupeKeys, err);
      runtime.error?.(danger(`${event.errorMessage}: ${String(err)}`));
      const spooledReplay = isTelegramSpooledReplayUpdate(event.ctx.update);
      if (err instanceof TelegramPairingStoreReadError || spooledReplay) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
        // Spooled replays are durably retried; live updates get one apology
        // because they are acked without replay.
        if (spooledReplay) {
          return;
        }
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(
              event.chatId,
              "⚠️ Couldn't process this message, please try again in a moment.",
              {
                reply_parameters: {
                  message_id: event.msg.message_id,
                  allow_sending_without_reply: true,
                },
              },
            ),
        }).catch(() => {});
      }
    }
  };

  bot.on("message", async (ctx) => {
    const msg = ctx.message;
    if (!msg) {
      return;
    }
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isForum = await resolveTelegramForumFlag({
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      isGroup,
      isForum: msg.chat.is_forum,
      isTopicMessage: msg.is_topic_message,
      getChat,
    });
    const normalizedMsg = withResolvedTelegramForumFlag(msg, isForum);
    // Bot-authored message updates can be echoed back by Telegram. Skip them here
    // and rely on the dedicated channel_post handler for channel-originated posts.
    if (normalizedMsg.from?.id != null && normalizedMsg.from.id === ctx.me?.id) {
      return;
    }
    await handleInboundMessageLike({
      ctxForDedupe: ctx,
      ctx: buildSyntheticContext(ctx, normalizedMsg),
      msg: normalizedMsg,
      chatId: normalizedMsg.chat.id,
      isGroup,
      isForum,
      messageThreadId: normalizedMsg.message_thread_id,
      senderId: normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "",
      senderUsername: normalizedMsg.from?.username ?? "",
      requireConfiguredGroup: false,
      sendOversizeWarning: true,
      oversizeLogMessage: "media exceeds size limit",
      errorMessage: "handler failed",
    });
  });

  bot.on("edited_message", async (ctx) => {
    const msg = ctx.editedMessage;
    if (!msg) {
      return;
    }
    await recordEditedMessageForReplyChain({
      ctxForDedupe: ctx,
      msg,
      requireConfiguredGroup: false,
      botUserId: ctx.me?.id ?? opts.botInfo?.id,
    });
  });

  // Handle channel posts — enables bot-to-bot communication via Telegram channels.
  // Telegram bots cannot see other bot messages in groups, but CAN in channels.
  // This handler normalizes channel_post updates into the standard message pipeline.
  bot.on("channel_post", async (ctx) => {
    const post = ctx.channelPost;
    if (!post) {
      return;
    }

    const chatId = post.chat.id;
    const syntheticMsg = normalizeChannelPostMessage(post);

    await handleInboundMessageLike({
      ctxForDedupe: ctx,
      ctx: buildSyntheticContext(ctx, syntheticMsg),
      msg: syntheticMsg,
      chatId,
      isGroup: true,
      isForum: false,
      senderId:
        post.sender_chat?.id != null
          ? String(post.sender_chat.id)
          : post.from?.id != null
            ? String(post.from.id)
            : "",
      senderUsername: post.sender_chat?.username ?? post.from?.username ?? "",
      requireConfiguredGroup: true,
      sendOversizeWarning: false,
      oversizeLogMessage: "channel post media exceeds size limit",
      errorMessage: "channel_post handler failed",
    });
  });

  bot.on("edited_channel_post", async (ctx) => {
    const post = ctx.editedChannelPost;
    if (!post) {
      return;
    }
    await recordEditedMessageForReplyChain({
      ctxForDedupe: ctx,
      msg: normalizeChannelPostMessage(post),
      requireConfiguredGroup: true,
      botUserId: ctx.me?.id ?? opts.botInfo?.id,
    });
  });
}

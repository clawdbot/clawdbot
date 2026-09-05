import type { Context } from "grammy";
import type { Message } from "grammy/types";
import type { TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveNativeCommandsEnabled } from "openclaw/plugin-sdk/native-command-config-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { TelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import { createTelegramInboundProcessing } from "./bot-handlers.inbound-processing.js";
import type { TelegramInboundProcessing } from "./bot-handlers.inbound-processing.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type {
  RegisterTelegramHandlerParams,
  TelegramInboundDisposition,
  TelegramInboundPipeline,
} from "./bot-handlers.types.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";
import {
  buildTelegramThreadParams,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramForumFlag,
  type TelegramThreadSpec,
  withResolvedTelegramForumFlag,
  TelegramPairingStoreReadError,
} from "./bot/helpers.js";
import type { TelegramContext, TelegramGetChat } from "./bot/types.js";
import { hasTelegramCustomCommand } from "./command-config.js";
import { resolveTelegramIgnoreDisposition, TELEGRAM_IGNORE_HELP_TEXT } from "./ignore-command.js";
import { emitTelegramLiveLocationMessageHook } from "./location-message-hook.js";
import type { TelegramMessageDispatchReplayClaim } from "./message-dispatch-dedupe.js";

type TelegramMessageHandlerParams = Pick<
  RegisterTelegramHandlerParams,
  "accountId" | "bot" | "cfg" | "removeMessageFromGroupHistory" | "shouldSkipUpdate" | "telegramCfg"
> & {
  opts: Pick<RegisterTelegramHandlerParams["opts"], "botInfo">;
  runtime: Pick<RegisterTelegramHandlerParams["runtime"], "error">;
};

type TelegramMessageHandlerRuntime = Pick<
  TelegramMessagePipeline,
  | "normalizePromptContextMinTimestampMs"
  | "promptContextBoundaryOptions"
  | "releaseDispatchDedupeClaims"
  | "claimMessageDispatchDedupe"
  | "buildSyntheticContext"
  | "resolveTelegramSessionState"
  | "resolvePromptContextAmbientWatermark"
  | "removeMessageFromReplyChain"
  | "isMessageIgnoredForReplyChain"
> & {
  recordMessageForReplyChain: (
    ...args: Parameters<TelegramMessagePipeline["recordMessageForReplyChain"]>
  ) => Promise<unknown>;
};

interface TelegramInboundHandlers {
  handleMessage: (ctx: Context) => Promise<TelegramInboundDisposition>;
  handleEditedMessage: (ctx: Context) => Promise<TelegramInboundDisposition>;
  handleChannelPost: (ctx: Context) => Promise<TelegramInboundDisposition>;
  handleEditedChannelPost: (ctx: Context) => Promise<TelegramInboundDisposition>;
}

function createTelegramInboundHandlers(
  {
    accountId,
    bot,
    cfg,
    opts,
    removeMessageFromGroupHistory,
    runtime,
    shouldSkipUpdate,
    telegramCfg,
  }: TelegramMessageHandlerParams,
  messageRuntime: TelegramMessageHandlerRuntime,
  authorizationRuntime: Pick<TelegramHandlerAuthorization, "authorizeInboundMessage">,
  inboundRuntime: Pick<
    TelegramInboundProcessing,
    "beginPendingBufferedMessageIgnore" | "beginPendingMediaGroupIgnore" | "processInboundMessage"
  >,
): TelegramInboundHandlers {
  const {
    normalizePromptContextMinTimestampMs,
    promptContextBoundaryOptions,
    releaseDispatchDedupeClaims,
    claimMessageDispatchDedupe,
    buildSyntheticContext,
    resolveTelegramSessionState,
    resolvePromptContextAmbientWatermark,
    recordMessageForReplyChain,
    removeMessageFromReplyChain,
    isMessageIgnoredForReplyChain,
  } = messageRuntime;
  const { authorizeInboundMessage } = authorizationRuntime;
  const { beginPendingBufferedMessageIgnore, beginPendingMediaGroupIgnore, processInboundMessage } =
    inboundRuntime;
  const ignoreEnabled =
    resolveNativeCommandsEnabled({
      providerId: "telegram",
      providerSetting: telegramCfg.commands?.native,
      globalSetting: cfg.commands?.native,
    }) &&
    !hasTelegramCustomCommand({
      commands: telegramCfg.customCommands,
      command: "ignore",
    });
  const getChat: TelegramGetChat = bot.api.getChat.bind(bot.api);
  const sendIgnoreHelp = async (msg: Message, threadSpec: TelegramThreadSpec) => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime,
      fn: () =>
        bot.api.sendMessage(msg.chat.id, TELEGRAM_IGNORE_HELP_TEXT, {
          ...buildTelegramThreadParams(threadSpec),
          reply_parameters: {
            message_id: msg.message_id,
            allow_sending_without_reply: true,
          },
        }),
    }).catch(() => {});
  };
  const resolveBotUserId = (ctx: { me?: { id?: number } }): number => {
    const botUserId = ctx.me?.id ?? opts.botInfo?.id;
    if (botUserId == null) {
      throw new Error("Telegram bot identity is unavailable");
    }
    return botUserId;
  };
  type InboundTelegramEvent = {
    ctxForDedupe: TelegramUpdateKeyContext;
    ctx: TelegramContext;
    botUserId: number;
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
    ignoreDisposition?: ReturnType<typeof resolveTelegramIgnoreDisposition>;
    pendingMediaGroupIgnore?: ReturnType<typeof beginPendingMediaGroupIgnore>;
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
    botUserId: number;
    botUsername?: string;
    providerUpdate?: { id: number; kind: "edited_message" | "edited_channel_post" };
  }) => {
    if (shouldSkipUpdate(params.ctxForDedupe)) {
      return;
    }
    const msg = params.msg;
    const ignoreDisposition = ignoreEnabled
      ? resolveTelegramIgnoreDisposition(msg, params.botUsername)
      : "keep";
    // Pause the album before forum/auth work can outlive its flush timer, but keep cancellation
    // reversible until the edited command is authorized.
    const pendingMediaGroupIgnore =
      ignoreDisposition === "keep" ? undefined : beginPendingMediaGroupIgnore(msg);
    const pendingBufferedMessageIgnore =
      ignoreDisposition === "keep" ? undefined : beginPendingBufferedMessageIgnore(msg);
    try {
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
        senderId: normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "",
        senderUsername: normalizedMsg.from?.username ?? "",
        requireConfiguredGroup: params.requireConfiguredGroup,
        dmAccess: "silent",
      });
      if (!gate.allowed) {
        pendingBufferedMessageIgnore?.settle(false);
        await pendingMediaGroupIgnore?.settle(false);
        return;
      }
      if (ignoreDisposition !== "keep") {
        pendingBufferedMessageIgnore?.settle(true);
        await pendingMediaGroupIgnore?.settle(true);
        // Reply-chain cache and rolling group history are independent prompt context owners.
        removeMessageFromGroupHistory(normalizedMsg, gate.context.threadSpec);
        // The durable privacy owner is independent from transient buffer/album ownership.
        await removeMessageFromReplyChain(normalizedMsg);
        if (ignoreDisposition === "help") {
          await sendIgnoreHelp(normalizedMsg, gate.context.threadSpec);
        }
        return;
      }
      if (await isMessageIgnoredForReplyChain(normalizedMsg)) {
        return;
      }
      await recordMessageForReplyChain(
        normalizedMsg,
        gate.context.threadSpec,
        params.botUserId,
        params.botUsername,
      );
      if (params.providerUpdate) {
        emitTelegramLiveLocationMessageHook({
          accountId,
          msg: normalizedMsg,
          updateId: params.providerUpdate.id,
          updateKind: params.providerUpdate.kind,
          isForum,
        });
      }
    } catch (error) {
      pendingBufferedMessageIgnore?.settle(false);
      await pendingMediaGroupIgnore?.settle(false).catch(() => undefined);
      throw error;
    }
  };

  const handleInboundMessageLike = async (
    event: InboundTelegramEvent,
  ): Promise<TelegramInboundDisposition> => {
    let dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[] = [];
    try {
      if (shouldSkipUpdate(event.ctxForDedupe)) {
        await event.pendingMediaGroupIgnore?.settle(false);
        return { kind: "ignored" };
      }
      const gate = await authorizeInboundMessage({
        msg: event.msg,
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        senderId: event.senderId,
        senderUsername: event.senderUsername,
        requireConfiguredGroup: event.requireConfiguredGroup,
        dmAccess: "challenge",
      });
      if (!gate.allowed) {
        await event.pendingMediaGroupIgnore?.settle(false);
        return { kind: "ignored" };
      }
      const ignoreDisposition =
        event.ignoreDisposition ??
        (ignoreEnabled
          ? resolveTelegramIgnoreDisposition(
              event.msg,
              event.ctx.me?.username ?? opts.botInfo?.username,
            )
          : "keep");
      if (ignoreDisposition !== "keep") {
        // Authorization, not whether a buffered owner happened to exist, decides the command.
        // Every ignored update gets a durable privacy owner so a later edit/replay cannot revive
        // it after native-command policy or bot identity changes.
        await event.pendingMediaGroupIgnore?.settle(true);
        removeMessageFromGroupHistory(event.msg, gate.context.threadSpec);
        await removeMessageFromReplyChain(event.msg);
        if (ignoreDisposition === "help") {
          await sendIgnoreHelp(event.msg, gate.context.threadSpec);
        }
        return { kind: "ignored" };
      }
      if (await isMessageIgnoredForReplyChain(event.msg)) {
        return { kind: "ignored" };
      }
      const { effectiveDmAllow } = gate;
      const {
        dmPolicy,
        resolvedThreadId,
        storeAllowFrom,
        groupConfig,
        topicConfig,
        effectiveGroupAllow,
        threadSpec,
      } = gate.context;

      const sessionState = resolveTelegramSessionState({
        chatId: event.chatId,
        isGroup: event.isGroup,
        threadSpec,
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

      const dispatchDedupe = await claimMessageDispatchDedupe(event.msg, event.botUserId);
      if (!dispatchDedupe.process) {
        return { kind: "ignored" };
      }
      dispatchDedupeClaims = dispatchDedupe.claims;
      if (!event.msg.media_group_id) {
        await recordMessageForReplyChain(
          event.msg,
          gate.context.threadSpec,
          event.botUserId,
          event.ctx.me?.username ?? opts.botInfo?.username,
        );
      }
      return await processInboundMessage({
        authorizationCfg: gate.context.cfg,
        ctx: event.ctx,
        msg: event.msg,
        ignoreEnabled,
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        threadSpec,
        dmPolicy,
        storeAllowFrom,
        senderId: event.senderId,
        effectiveGroupAllow,
        effectiveDmAllow,
        channelIngressResolver: gate.resolveChannelIngress,
        groupConfig: event.isGroup ? (groupConfig as TelegramGroupConfig | undefined) : undefined,
        topicConfig,
        sendOversizeWarning: event.sendOversizeWarning,
        oversizeLogMessage: event.oversizeLogMessage,
        dispatchDedupeClaims,
        ...promptContextBoundaryOptions(promptContextMinTimestampMs, promptContextAmbientWatermark),
      });
    } catch (err) {
      await event.pendingMediaGroupIgnore?.settle(false).catch(() => undefined);
      releaseDispatchDedupeClaims(dispatchDedupeClaims, err);
      runtime.error?.(danger(`${event.errorMessage}: ${String(err)}`));
      const spooledReplay = isTelegramSpooledReplayUpdate(event.ctx.update);
      if (err instanceof TelegramPairingStoreReadError || spooledReplay) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
        // Spooled replays are durably retried; live updates get one apology
        // because they are acked without replay.
        if (spooledReplay) {
          return { kind: "ignored" };
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
      return { kind: "ignored" };
    }
  };

  const handleMessage = async (ctx: Context): Promise<TelegramInboundDisposition> => {
    const msg = ctx.message;
    if (!msg) {
      return { kind: "ignored" };
    }
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const botUserId = resolveBotUserId(ctx);
    // Bot-authored message updates can be echoed back by Telegram. Skip them here
    // and rely on the dedicated channel_post handler for channel-originated posts.
    if (msg.from?.id != null && msg.from.id === botUserId) {
      return { kind: "ignored" };
    }
    const ignoreDisposition = ignoreEnabled
      ? resolveTelegramIgnoreDisposition(msg, ctx.me?.username ?? opts.botInfo?.username)
      : "keep";
    // Pause an existing album before forum/auth resolution yields. Authorization still owns
    // whether the command may cancel it; a denied candidate only resumes the original timer.
    const pendingMediaGroupIgnore =
      ignoreDisposition === "keep" ? undefined : beginPendingMediaGroupIgnore(msg);
    try {
      const isForum = await resolveTelegramForumFlag({
        chatId: msg.chat.id,
        chatType: msg.chat.type,
        isGroup,
        isForum: msg.chat.is_forum,
        isTopicMessage: msg.is_topic_message,
        getChat,
      });
      const normalizedMsg = withResolvedTelegramForumFlag(msg, isForum);
      return await handleInboundMessageLike({
        ctxForDedupe: ctx,
        ctx: buildSyntheticContext(ctx, normalizedMsg),
        botUserId,
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
        ignoreDisposition,
        pendingMediaGroupIgnore,
      });
    } catch (error) {
      await pendingMediaGroupIgnore?.settle(false).catch(() => undefined);
      throw error;
    }
  };

  const handleEditedMessage = async (ctx: Context): Promise<TelegramInboundDisposition> => {
    const msg = ctx.editedMessage;
    if (!msg) {
      return { kind: "ignored" };
    }
    await recordEditedMessageForReplyChain({
      ctxForDedupe: ctx,
      msg,
      requireConfiguredGroup: false,
      botUserId: resolveBotUserId(ctx),
      botUsername: ctx.me?.username ?? opts.botInfo?.username,
      providerUpdate:
        typeof ctx.update?.update_id === "number"
          ? { id: ctx.update.update_id, kind: "edited_message" }
          : undefined,
    });
    return { kind: "recorded" };
  };

  const handleChannelPost = async (ctx: Context): Promise<TelegramInboundDisposition> => {
    const post = ctx.channelPost;
    if (!post) {
      return { kind: "ignored" };
    }

    const chatId = post.chat.id;
    const syntheticMsg = normalizeChannelPostMessage(post);
    const ignoreDisposition = ignoreEnabled
      ? resolveTelegramIgnoreDisposition(syntheticMsg, ctx.me?.username ?? opts.botInfo?.username)
      : "keep";
    // Channel posts share the same album registry as ordinary messages. Pause an /ignore
    // candidate before authorization so the album cannot flush while that decision awaits.
    const pendingMediaGroupIgnore =
      ignoreDisposition === "keep" ? undefined : beginPendingMediaGroupIgnore(syntheticMsg);
    try {
      return await handleInboundMessageLike({
        ctxForDedupe: ctx,
        ctx: buildSyntheticContext(ctx, syntheticMsg),
        botUserId: resolveBotUserId(ctx),
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
        ignoreDisposition,
        pendingMediaGroupIgnore,
      });
    } catch (error) {
      await pendingMediaGroupIgnore?.settle(false).catch(() => undefined);
      throw error;
    }
  };

  const handleEditedChannelPost = async (ctx: Context): Promise<TelegramInboundDisposition> => {
    const post = ctx.editedChannelPost;
    if (!post) {
      return { kind: "ignored" };
    }
    await recordEditedMessageForReplyChain({
      ctxForDedupe: ctx,
      msg: normalizeChannelPostMessage(post),
      requireConfiguredGroup: true,
      botUserId: resolveBotUserId(ctx),
      botUsername: ctx.me?.username ?? opts.botInfo?.username,
      providerUpdate:
        typeof ctx.update?.update_id === "number"
          ? { id: ctx.update.update_id, kind: "edited_channel_post" }
          : undefined,
    });
    return { kind: "recorded" };
  };

  return { handleMessage, handleEditedMessage, handleChannelPost, handleEditedChannelPost };
}

export function createTelegramInboundPipeline({
  params,
  message,
  authorization,
}: {
  params: RegisterTelegramHandlerParams;
  message: TelegramMessagePipeline;
  authorization: TelegramHandlerAuthorization;
}): TelegramInboundPipeline {
  const handlers = createTelegramInboundHandlers(
    params,
    message,
    authorization,
    createTelegramInboundProcessing({ params, message }),
  );
  return {
    handle: async (ctx) => {
      if (ctx.message) {
        return await handlers.handleMessage(ctx);
      }
      if (ctx.editedMessage) {
        return await handlers.handleEditedMessage(ctx);
      }
      if (ctx.channelPost) {
        return await handlers.handleChannelPost(ctx);
      }
      if (ctx.editedChannelPost) {
        return await handlers.handleEditedChannelPost(ctx);
      }
      return { kind: "ignored" };
    },
  };
}

export function registerTelegramInboundHandlers({
  bot,
  pipeline,
}: {
  bot: RegisterTelegramHandlerParams["bot"];
  pipeline: TelegramInboundPipeline;
}): void {
  bot.on("message", pipeline.handle);
  bot.on("edited_message", pipeline.handle);
  bot.on("channel_post", pipeline.handle);
  bot.on("edited_channel_post", pipeline.handle);
}

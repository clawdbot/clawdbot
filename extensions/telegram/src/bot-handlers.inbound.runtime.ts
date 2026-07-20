// Telegram inbound buffering, media resolution, and message dispatch.
import type { Message } from "grammy/types";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import type {
  DmPolicy,
  OpenClawConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { NormalizedAllowFrom } from "./bot-access.js";
import {
  buildTelegramInboundDebounceConversationKey,
  buildTelegramInboundDebounceKey,
} from "./bot-handlers.debounce-key.js";
import {
  createTelegramInboundDebounceRuntime,
  type TelegramDebounceEntry,
} from "./bot-handlers.inbound-debounce.runtime.js";
import { createTelegramInboundMediaGroupRuntime } from "./bot-handlers.inbound-media-group.runtime.js";
import { createTelegramInboundTextRuntime } from "./bot-handlers.inbound-text.runtime.js";
import {
  isDurablyRetryableInboundMediaError,
  isMediaSizeLimitError,
  TelegramBotApiFileTooLargeError,
} from "./bot-handlers.media.js";
import type { TelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import type { TelegramAmbientTranscriptWatermark } from "./bot-message-context.types.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import { getTelegramTextParts } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
import type { TelegramMessageDispatchReplayClaim } from "./message-dispatch-dedupe.js";

export function createTelegramHandlerInboundRuntime(
  {
    cfg,
    accountId,
    bot,
    opts,
    runtime,
    mediaMaxBytes,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
  }: RegisterTelegramHandlerParams,
  messageRuntime: TelegramHandlerMessageRuntime,
) {
  const {
    mediaRuntimeWithAbort,
    promptContextBoundaryOptions,
    releaseDispatchDedupeClaims,
    createSpooledReplayParticipantForBufferedWork,
  } = messageRuntime;
  const {
    inboundDebouncer,
    resolveTelegramDebounceEntryMs,
    shouldDebounceTelegramEntry,
    resolveTelegramDebounceLane,
  } = createTelegramInboundDebounceRuntime({ cfg, bot, runtime }, messageRuntime);

  const { handleMediaGroup, shouldSkipMediaDownloadForUnaddressedMentionGroup } =
    createTelegramInboundMediaGroupRuntime(
      {
        accountId,
        bot,
        opts,
        runtime,
        mediaMaxBytes,
        logger,
        resolveGroupActivation,
        resolveGroupRequireMention,
      },
      messageRuntime,
    );

  const { handleTextFragment } = createTelegramInboundTextRuntime(
    { opts, runtime },
    messageRuntime,
  );
  const processInboundMessage = async (params: {
    authorizationCfg: OpenClawConfig;
    ctx: TelegramContext;
    msg: Message;
    chatId: number;
    isGroup: boolean;
    isForum: boolean;
    resolvedThreadId?: number;
    dmThreadId?: number;
    dmPolicy: DmPolicy;
    storeAllowFrom: string[];
    senderId: string;
    effectiveGroupAllow: NormalizedAllowFrom;
    effectiveDmAllow: NormalizedAllowFrom;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
    sendOversizeWarning: boolean;
    oversizeLogMessage: string;
    promptContextMinTimestampMs?: number;
    promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
    dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  }) => {
    const {
      authorizationCfg,
      ctx,
      msg,
      chatId,
      isGroup,
      isForum,
      resolvedThreadId,
      dmThreadId,
      dmPolicy,
      storeAllowFrom,
      senderId,
      effectiveGroupAllow,
      effectiveDmAllow,
      groupConfig,
      topicConfig,
      sendOversizeWarning,
      oversizeLogMessage,
      promptContextMinTimestampMs,
      promptContextAmbientWatermark,
      dispatchDedupeClaims,
    } = params;

    const messageText = getTelegramTextParts(msg).text;
    const botUsername = ctx.me?.username;
    const isAbortControlMessage = isAbortRequestText(messageText, { botUsername });
    let abortControlAuthorized: Promise<boolean> | undefined;
    const isAuthorizedAbortControlMessage = () => {
      if (!isAbortControlMessage || !senderId) {
        return Promise.resolve(false);
      }
      abortControlAuthorized ??= resolveTelegramCommandIngressAuthorization({
        accountId,
        cfg: authorizationCfg,
        dmPolicy,
        isGroup,
        chatId,
        resolvedThreadId,
        senderId,
        effectiveDmAllow,
        effectiveGroupAllow,
        ownerAccess: { ownerList: [], senderIsOwner: false },
        eventKind: "message",
        allowTextCommands: true,
        hasControlCommand: true,
        modeWhenAccessGroupsOff: "allow",
        includeDmAllowForGroupCommands: false,
      }).then((gate) => gate.authorized);
      return abortControlAuthorized;
    };

    if (
      await handleTextFragment({
        ctx,
        msg,
        chatId,
        resolvedThreadId,
        dmThreadId,
        storeAllowFrom,
        isAbortControlMessage,
        isAuthorizedAbortControlMessage,
        promptContextMinTimestampMs,
        promptContextAmbientWatermark,
        dispatchDedupeClaims,
      })
    ) {
      return;
    }

    // Media group handling - buffer multi-image messages
    if (
      handleMediaGroup({
        authorizationCfg,
        ctx,
        msg,
        chatId,
        isGroup,
        isForum,
        resolvedThreadId,
        dmThreadId,
        storeAllowFrom,
        senderId,
        effectiveGroupAllow,
        effectiveDmAllow,
        groupConfig,
        topicConfig,
        promptContextMinTimestampMs,
        promptContextAmbientWatermark,
        dispatchDedupeClaims,
      })
    ) {
      return;
    }

    if (
      await shouldSkipMediaDownloadForUnaddressedMentionGroup({
        authorizationCfg,
        ctx,
        msg,
        chatId,
        isGroup,
        isForum,
        resolvedThreadId,
        dmThreadId,
        senderId,
        effectiveGroupAllow,
        effectiveDmAllow,
        groupConfig,
        topicConfig,
      })
    ) {
      releaseDispatchDedupeClaims(dispatchDedupeClaims);
      return;
    }

    let media: Awaited<ReturnType<typeof resolveMedia>>;
    try {
      media = await resolveMedia({
        ctx,
        maxBytes: mediaMaxBytes,
        ...mediaRuntimeWithAbort,
      });
    } catch (mediaErr) {
      if (isMediaSizeLimitError(mediaErr)) {
        if (sendOversizeWarning) {
          const limitMb =
            mediaErr instanceof TelegramBotApiFileTooLargeError
              ? Math.min(mediaErr.limitMb, Math.round(mediaMaxBytes / (1024 * 1024)))
              : Math.round(mediaMaxBytes / (1024 * 1024));
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, {
                reply_parameters: {
                  message_id: msg.message_id,
                  allow_sending_without_reply: true,
                },
              }),
          }).catch(() => {});
        }
        logger.warn({ chatId, error: String(mediaErr) }, oversizeLogMessage);
        releaseDispatchDedupeClaims(dispatchDedupeClaims);
        return;
      }
      logger.warn({ chatId, error: String(mediaErr) }, "media fetch failed");
      const retryable = isDurablyRetryableInboundMediaError(mediaErr);
      if (retryable) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: mediaErr });
      }
      if (!(retryable && isTelegramSpooledReplayUpdate(ctx.update))) {
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(chatId, "⚠️ Failed to download media. Please try again.", {
              reply_parameters: {
                message_id: msg.message_id,
                allow_sending_without_reply: true,
              },
            }),
        }).catch(() => {});
      }
      releaseDispatchDedupeClaims(dispatchDedupeClaims, retryable ? mediaErr : undefined);
      return;
    }

    // Skip sticker-only messages where the sticker was skipped (animated/video)
    // These have no media and no text content to process.
    const hasText = Boolean(getTelegramTextParts(msg).text.trim());
    if (msg.sticker && !media && !hasText) {
      logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
      releaseDispatchDedupeClaims(dispatchDedupeClaims);
      return;
    }

    const allMedia = media
      ? [
          {
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata,
          },
        ]
      : [];
    const conversationKey = buildTelegramInboundDebounceConversationKey({
      chatId,
      threadId: resolvedThreadId ?? dmThreadId,
    });
    const debounceLane = resolveTelegramDebounceLane(msg);
    const debounceKey = senderId
      ? buildTelegramInboundDebounceKey({
          accountId,
          conversationKey,
          senderId,
          debounceLane,
        })
      : null;
    if (senderId && (await isAuthorizedAbortControlMessage())) {
      for (const lane of ["default", "forward"] as const) {
        inboundDebouncer.cancelKey(
          buildTelegramInboundDebounceKey({
            accountId,
            conversationKey,
            senderId,
            debounceLane: lane,
          }),
        );
      }
    }
    const debounceEntry: TelegramDebounceEntry = {
      ctx,
      msg,
      allMedia,
      storeAllowFrom,
      receivedAtMs: Date.now(),
      debounceKey: isAbortControlMessage ? null : debounceKey,
      debounceLane,
      botUsername,
      ...promptContextBoundaryOptions(promptContextMinTimestampMs, promptContextAmbientWatermark),
      dispatchDedupeClaims,
    };
    if (
      debounceEntry.debounceKey &&
      resolveTelegramDebounceEntryMs(debounceEntry) > 0 &&
      shouldDebounceTelegramEntry(debounceEntry)
    ) {
      debounceEntry.spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
        `inbound-debounce:${debounceEntry.debounceKey}`,
      );
    }
    await inboundDebouncer.enqueue(debounceEntry);
  };

  return { processInboundMessage };
}

export type TelegramHandlerInboundRuntime = ReturnType<typeof createTelegramHandlerInboundRuntime>;

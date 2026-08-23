import type { Message } from "grammy/types";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import type {
  DmPolicy,
  OpenClawConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { NormalizedAllowFrom } from "./bot-access.js";
import {
  buildTelegramInboundDebounceConversationKey,
  buildTelegramInboundDebounceKey,
} from "./bot-handlers.debounce-key.js";
import {
  createTelegramInboundBuffers,
  type TelegramDebounceEntry,
} from "./bot-handlers.inbound-buffer.js";
import { createTelegramInboundMedia } from "./bot-handlers.inbound-media.js";
import {
  isDurablyRetryableInboundMediaError,
  isMediaSizeLimitError,
  TelegramBotApiFileTooLargeError,
} from "./bot-handlers.media.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type {
  RegisterTelegramHandlerParams,
  TelegramInboundDisposition,
} from "./bot-handlers.types.js";
import type { TelegramAmbientTranscriptWatermark } from "./bot-message-context.types.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import {
  buildTelegramThreadParams,
  getTelegramTextParts,
  resolveTelegramMessageThreadSpec,
  resolveTelegramPrimaryMedia,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveTelegramCommandIngressAuthorization } from "./ingress.js";
import type { TelegramMessageDispatchReplayClaim } from "./message-dispatch-dedupe.js";

export interface TelegramInboundProcessing {
  processInboundMessage: (params: TelegramInboundMessage) => Promise<TelegramInboundDisposition>;
}

type TelegramInboundMessage = {
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
};

export function createTelegramInboundProcessing({
  params: {
    cfg,
    accountId,
    bot,
    opts,
    runtime,
    mediaMaxBytes,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
  },
  message,
}: {
  params: RegisterTelegramHandlerParams;
  message: TelegramMessagePipeline;
}): TelegramInboundProcessing {
  const {
    resolveMediaRuntime,
    recordMessageResolvedMedia,
    promptContextBoundaryOptions,
    releaseDispatchDedupeClaims,
    createSpooledReplayParticipantForBufferedWork,
  } = message;
  const {
    inboundDebouncer,
    resolveTelegramDebounceEntryMs,
    shouldDebounceTelegramEntry,
    resolveTelegramDebounceLane,
    handleTextFragment,
  } = createTelegramInboundBuffers({ params: { cfg, bot, runtime, opts }, message });

  const { handleMediaGroup, resolveUnaddressedGroupMediaDisposition } = createTelegramInboundMedia({
    params: {
      accountId,
      bot,
      opts,
      runtime,
      mediaMaxBytes,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
    },
    message,
  });
  const processInboundMessage = async (
    params: TelegramInboundMessage,
  ): Promise<TelegramInboundDisposition> => {
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
      return { kind: "buffered", buffer: "text-fragment" };
    }

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
      return { kind: "buffered", buffer: "media-group" };
    }

    const mediaDisposition = await resolveUnaddressedGroupMediaDisposition({
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
    });
    if (mediaDisposition === "skip") {
      releaseDispatchDedupeClaims(dispatchDedupeClaims);
      return { kind: "ignored" };
    }

    const nativeMedia = resolveTelegramPrimaryMedia(msg);
    const mediaRuntime = resolveMediaRuntime();
    let media: Awaited<ReturnType<typeof resolveMedia>> = null;
    try {
      media = await resolveMedia({
        ctx,
        maxBytes: mediaMaxBytes,
        ...mediaRuntime,
      });
      if (media) {
        await recordMessageResolvedMedia({ msg, media, botUserId: ctx.me?.id });
      }
    } catch (mediaErr) {
      const replayingSpooledUpdate = isTelegramSpooledReplayUpdate(ctx.update);
      const warningThreadParams = buildTelegramThreadParams(
        resolveTelegramMessageThreadSpec(msg, isForum),
      );
      if (mediaRuntime.abortSignal?.aborted && isDurablyRetryableInboundMediaError(mediaErr)) {
        // Abort mid-media-resolution must stay retryable for live updates too;
        // a clean claim release would settle the update as handled and silently
        // drop the message during shutdown or deadline cancellation.
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: mediaErr });
        releaseDispatchDedupeClaims(dispatchDedupeClaims, mediaErr);
        return { kind: "ignored" };
      }
      if (isMediaSizeLimitError(mediaErr)) {
        if (sendOversizeWarning && mediaDisposition !== "silent-ingest") {
          const limitMb =
            mediaErr instanceof TelegramBotApiFileTooLargeError
              ? Math.min(mediaErr.limitMb, Math.round(mediaMaxBytes / (1024 * 1024)))
              : Math.round(mediaMaxBytes / (1024 * 1024));
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, {
                ...warningThreadParams,
                reply_parameters: {
                  message_id: msg.message_id,
                  allow_sending_without_reply: true,
                },
              }),
          }).catch(() => {});
        }
        logger.warn({ chatId, error: String(mediaErr) }, oversizeLogMessage);
      } else {
        logger.warn({ chatId, error: String(mediaErr) }, "media fetch failed");
        const retryable = isDurablyRetryableInboundMediaError(mediaErr);
        if (retryable && replayingSpooledUpdate) {
          recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: mediaErr });
          releaseDispatchDedupeClaims(dispatchDedupeClaims, mediaErr);
          return { kind: "ignored" };
        }
        if (mediaDisposition !== "silent-ingest") {
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () =>
              bot.api.sendMessage(chatId, "⚠️ Failed to download media. Please try again.", {
                ...warningThreadParams,
                reply_parameters: {
                  message_id: msg.message_id,
                  allow_sending_without_reply: true,
                },
              }),
          }).catch(() => {});
        }
      }
    }

    const allMedia = nativeMedia
      ? [
          media
            ? {
                path: media.path,
                contentType: media.contentType,
                kind: media.kind,
                stickerMetadata: media.stickerMetadata,
              }
            : { kind: nativeMedia.kind },
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
    const shouldBufferDebounce = Boolean(
      debounceEntry.debounceKey &&
      resolveTelegramDebounceEntryMs(debounceEntry) > 0 &&
      shouldDebounceTelegramEntry(debounceEntry),
    );
    if (shouldBufferDebounce) {
      debounceEntry.spooledReplayParticipant = createSpooledReplayParticipantForBufferedWork(
        `inbound-debounce:${debounceEntry.debounceKey}`,
      );
    }
    await inboundDebouncer.enqueue(debounceEntry);
    return shouldBufferDebounce ? { kind: "buffered", buffer: "debounce" } : { kind: "processed" };
  };

  return { processInboundMessage };
}

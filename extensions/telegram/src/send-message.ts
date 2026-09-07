import type { Message } from "grammy/types";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { telegramCaptionDeliveryMetadata } from "./caption.js";
import { renderTelegramHtmlText } from "./format.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { planTelegramMediaBatches } from "./outbound-media-batches.js";
import {
  prepareTelegramOutboundMedia,
  resolveTelegramOutboundMediaSenders,
} from "./outbound-media.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import type { TelegramOutboundPromptContextMessage as TelegramMessageLike } from "./outbound-message-context.js";
import { buildTelegramThreadReplyParams } from "./reply-parameters.js";
import { isTelegramEmptyContentError } from "./rich-plain-fallback.js";
import {
  logTelegramOutboundSendOk,
  resolveAcceptedReplyToMessageId,
  resolveTelegramMessageIdOrThrow,
  sendLogger,
  toAcceptedThreadScopedParams,
  withTelegramApiContext,
} from "./send-context.js";
import {
  isTelegramPhotoLimitError,
  isTelegramVoiceMessagesForbiddenError,
} from "./send-error-predicates.js";
import { createTelegramTextSender } from "./send-message-text.js";
import type { TelegramSendOpts, TelegramSendResult } from "./send-message-types.js";
import {
  buildTelegramProviderDeliveryResult,
  prepareTelegramOutbound,
  reportTelegramProviderDelivery,
} from "./send-outbound.js";
import { createTelegramPreparedSender, type TelegramPreparedSendPart } from "./send-prepared.js";
import {
  buildOutboundMediaLoadOptions,
  getImageMetadata,
  loadWebMedia,
  probeVideoDimensions,
  resolveMarkdownTableMode,
} from "./send.runtime.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { resolveTelegramBotUserIdFromToken } from "./token-fingerprint.js";

const MAX_TELEGRAM_PHOTO_DIMENSION_SUM = 10_000;
const MAX_TELEGRAM_PHOTO_ASPECT_RATIO = 20;

export async function sendMessageTelegram(
  to: string,
  text: string,
  opts: TelegramSendOpts,
): Promise<TelegramSendResult> {
  return withTelegramApiContext(opts, async (apiContext): Promise<TelegramSendResult> => {
    const { cfg, account, api, ownerAgentId } = apiContext;
    const botUserId = resolveTelegramBotUserIdFromToken(opts.token || account.token);
    const {
      chatId,
      threadSpec,
      threadParams: preparedThreadParams,
      request: requestWithChatNotFound,
    } = await prepareTelegramOutbound({
      to,
      context: apiContext,
      opts,
      thread: {
        messageThreadId: opts.messageThreadId,
        directMessagesTopicId: opts.directMessagesTopicId,
        replyToMessageId: opts.replyToMessageId,
        replyQuoteText: opts.quoteText,
        useReplyIdAsQuoteSource: true,
      },
      request: { kind: "nonIdempotent" },
    });
    const deliveryResults: TelegramSendResult[] = [];
    let finalMediaBatch = true;
    const reportDelivery = async (
      messageId: string | number,
      deliveredChatId: string | number,
      message: TelegramMessageLike,
      meta?: TelegramSendResult["meta"],
      kind?: "text" | "media",
      onPrepared?: (delivery: TelegramSendResult) => void,
    ): Promise<TelegramSendResult> => {
      return await reportTelegramProviderDelivery({
        message,
        messageId,
        fallbackChatId: deliveredChatId,
        successfulSendThread: threadSpec,
        ...(meta ? { meta } : {}),
        ...(kind ? { kind } : {}),
        onPrepared: (delivery) => {
          deliveryResults.push({
            ...delivery,
            receipt:
              delivery.receipt ??
              createMessageReceiptFromOutboundResults({ results: [delivery], kind }),
          });
          onPrepared?.(delivery);
        },
        onDeliveryResult: opts.onDeliveryResult,
      });
    };
    const recordDeliveredPromptContext = async (
      params: Omit<
        Parameters<typeof recordOutboundMessageForPromptContext>[0],
        "cfg" | "account" | "botUserId" | "chatId" | "promptContextProjection"
      >,
      finalPart: boolean,
    ) => {
      const plan = opts.promptContextProjectionPlan;
      const projection = plan?.cursor.take(plan.finalPart && finalPart && finalMediaBatch);
      const recorded = await recordOutboundMessageForPromptContext({
        cfg,
        ownerAgentId,
        account,
        ...(botUserId !== undefined ? { botUserId } : {}),
        chatId,
        ...(threadSpec?.id !== undefined ? { messageThreadId: threadSpec.id } : {}),
        ...(threadSpec ? { successfulSendThread: threadSpec } : {}),
        ...params,
        promptContextProjection: projection,
      });
      if (projection && !recorded) {
        // A delivered-but-uncached part must prevent later parts from claiming
        // complete transcript coverage.
        plan?.cursor.invalidate();
      }
    };
    const mediaUrls = (opts.mediaUrls?.length ? opts.mediaUrls : [opts.mediaUrl ?? ""])
      .map((url) => url.trim())
      .filter(Boolean);
    const mediaMaxBytes =
      opts.maxBytes ??
      (typeof account.config.mediaMaxMb === "number" ? account.config.mediaMaxMb : 100) *
        1024 *
        1024;
    const replyMarkup = buildInlineKeyboard(opts.buttons);

    const singleUseReplyTo =
      opts.replyToIdSource === "implicit" &&
      opts.replyToMode !== undefined &&
      isSingleUseReplyToMode(opts.replyToMode);
    let threadParamsWithoutReply: ReturnType<typeof buildTelegramThreadReplyParams> | undefined;
    const buildThreadParams = (includeReplyTo: boolean) => {
      if (includeReplyTo) {
        return preparedThreadParams;
      }
      threadParamsWithoutReply ??= buildTelegramThreadReplyParams({ thread: threadSpec });
      return threadParamsWithoutReply;
    };
    const textMode = opts.textMode ?? "markdown";
    // Caller-authored HTML keeps legacy parse_mode HTML semantics (literal
    // newlines, 4096 chunking) even on rich accounts; blocks are markdown-only.
    const useRichMessages = account.config.richMessages === true && textMode !== "html";
    const tableMode =
      opts.tableMode ??
      resolveMarkdownTableMode({
        cfg,
        channel: "telegram",
        accountId: account.accountId,
        supportsBlockTables: useRichMessages,
      });
    const renderHtmlText = (value: string) =>
      renderTelegramHtmlText(value, { textMode, tableMode });
    // Resolve link preview setting from config (default: enabled).
    const linkPreviewEnabled = account.config.linkPreview ?? true;
    const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };

    const sender = createTelegramPreparedSender({
      api,
      chatId,
      warn: (message) => sendLogger.warn(message),
      request: async (send, label, options) => {
        await opts.onPlatformSendDispatch?.();
        return requestWithChatNotFound(send, label, options);
      },
      assertPlatformSendAuthorized: () => {
        opts.signal?.throwIfAborted();
        opts.assertPlatformSendAuthorized?.();
      },
    });
    const buildMediaReceipt = () => {
      const deliveries = new Map(deliveryResults.map((delivery) => [delivery.messageId, delivery]));
      const results = sender.parts.map((part) => {
        const messageId = String(part.messageId);
        const delivery =
          deliveries.get(messageId) ??
          buildTelegramProviderDeliveryResult({
            message: part.result,
            messageId,
            fallbackChatId: chatId,
            successfulSendThread: threadSpec,
            kind: "media",
          });
        const replyToId = resolveAcceptedReplyToMessageId(
          toAcceptedThreadScopedParams(part.acceptedParams),
        )?.toString();
        return {
          ...delivery,
          receipt: createMessageReceiptFromOutboundResults({
            results: [delivery],
            kind: "media",
            ...(replyToId ? { replyToId } : {}),
          }),
        };
      });
      const receipt = createMessageReceiptFromOutboundResults({ results, kind: "media" });
      receipt.parts = receipt.parts.map((part, index) => ({ ...part, index }));
      const replyToId = receipt.parts.find((part) => part.replyToId)?.replyToId;
      if (replyToId) {
        receipt.replyToId = replyToId;
      }
      return receipt;
    };
    const { sendChunkedText } = createTelegramTextSender({
      cfg,
      ownerAgentId,
      account,
      api,
      chatId,
      opts,
      replyMarkup,
      reportDelivery,
      recordDeliveredPromptContext,
      singleUseReplyTo,
      buildThreadParams,
      sender,
      textMode,
      tableMode,
      renderHtmlText,
      linkPreviewOptions,
      useRichMessages,
    });

    async function shouldSendTelegramImageAsPhoto(buffer: Buffer): Promise<boolean> {
      try {
        const metadata = await getImageMetadata(buffer);
        const width = metadata?.width;
        const height = metadata?.height;

        if (typeof width !== "number" || typeof height !== "number") {
          sendLogger.warn("Photo dimensions are unavailable. Sending as document instead.");
          return false;
        }

        const shorterSide = Math.min(width, height);
        const longerSide = Math.max(width, height);
        const isValidPhoto =
          width + height <= MAX_TELEGRAM_PHOTO_DIMENSION_SUM &&
          shorterSide > 0 &&
          longerSide <= shorterSide * MAX_TELEGRAM_PHOTO_ASPECT_RATIO;

        if (!isValidPhoto) {
          sendLogger.warn(
            `Photo dimensions (${width}x${height}) are not valid for Telegram photos. Sending as document instead.`,
          );
          return false;
        }
        return true;
      } catch (err) {
        sendLogger.warn(
          `Failed to validate photo dimensions: ${formatErrorMessage(err)}. Sending as document instead.`,
        );
        return false;
      }
    }

    const prepareMedia = async (mediaUrl: string, index: number) => {
      const media = await loadWebMedia(
        mediaUrl,
        buildOutboundMediaLoadOptions({
          maxBytes: mediaMaxBytes,
          mediaAccess: opts.mediaAccess,
          mediaLocalRoots: opts.mediaLocalRoots,
          mediaReadFile: opts.mediaReadFile,
          optimizeImages: opts.forceDocument ? false : undefined,
        }),
      );
      const mediaPlan = prepareTelegramOutboundMedia({
        media,
        text: index === 0 ? text : "",
        textMode,
        tableMode,
        forceDocument: opts.forceDocument,
        asVideoNote: opts.asVideoNote,
      });
      const sendImageAsPhoto =
        mediaPlan.deliveryKind !== "image" ||
        mediaPlan.isGif ||
        (await shouldSendTelegramImageAsPhoto(media.buffer));
      const { sender: mediaSender, documentSender } = resolveTelegramOutboundMediaSenders<Message>({
        api,
        chatId,
        media,
        plan: mediaPlan,
        forceDocument: opts.forceDocument,
        asVoice: opts.asVoice,
        sendImageAsPhoto,
      });
      return { index, media, mediaPlan, mediaSender, documentSender };
    };
    type PreparedMedia = Awaited<ReturnType<typeof prepareMedia>>;
    const sendMediaBatch = async (
      batch: [PreparedMedia, ...PreparedMedia[]],
    ): Promise<TelegramSendResult> => {
      const first = batch[0];
      const { media, mediaPlan, mediaSender, documentSender } = first;
      const batchReplyMarkup = first.index === 0 ? replyMarkup : undefined;
      finalMediaBatch = first.index + batch.length === mediaUrls.length;
      const { htmlCaption, plainCaption, followUpText } = mediaPlan;
      // If text exceeds Telegram's caption limit, send media without caption
      // then send text as a separate follow-up message.
      const needsSeparateText = Boolean(followUpText);
      // When splitting, put reply_markup only on the follow-up text (the "main" content),
      // not on the media message.
      const mediaThreadParams = buildThreadParams(!singleUseReplyTo || sender.parts.length === 0);
      const baseMediaParams = {
        ...mediaThreadParams,
        ...(!needsSeparateText && batchReplyMarkup ? { reply_markup: batchReplyMarkup } : {}),
      };
      const videoDimensions =
        mediaPlan.deliveryKind === "video" && !mediaPlan.isVideoNote
          ? await probeVideoDimensions(media.buffer)
          : undefined;
      const mediaParams = {
        ...(htmlCaption ? { caption: htmlCaption, parse_mode: "HTML" as const } : {}),
        ...baseMediaParams,
        ...(opts.silent === true ? { disable_notification: true } : {}),
        ...(videoDimensions
          ? { width: videoDimensions.width, height: videoDimensions.height }
          : {}),
      };
      let mediaParts: [TelegramPreparedSendPart, ...TelegramPreparedSendPart[]];
      let operation = mediaSender.operation;
      let deliveryKind = mediaSender.label;
      try {
        if (batch.length > 1) {
          try {
            const album = await sender.sendPhotoAlbum({
              files: batch.map((item) => item.mediaPlan.file),
              requestParams: mediaParams,
              plainCaption: htmlCaption ? plainCaption : undefined,
            });
            mediaParts = album.parts;
            operation = "sendMediaGroup";
          } catch (error) {
            if (!isTelegramPhotoLimitError(error)) {
              throw error;
            }
            // A definite photo-limit rejection accepts no album. Reuse singleton
            // delivery so Telegram can identify which photo requires a document.
            // The album's long caption follows every fallback attachment.
            first.mediaPlan.followUpText = undefined;
            batch.reduce((_previous, item) => item).mediaPlan.followUpText = followUpText;
            let result = await sendMediaBatch([first]);
            for (const item of batch.slice(1)) {
              result = await sendMediaBatch([item]);
            }
            return result;
          }
        } else {
          const delivery = await sender.sendMedia({
            sender: mediaSender,
            documentSender,
            requestParams: mediaParams,
            plainCaption: htmlCaption ? plainCaption : undefined,
          });
          mediaParts = [delivery];
          operation = delivery.sender.operation;
          deliveryKind = delivery.sender.label;
        }
      } catch (error) {
        if (
          mediaSender.label === "voice" &&
          isTelegramVoiceMessagesForbiddenError(error) &&
          first.index === 0 &&
          text.trim()
        ) {
          logVerbose(
            "telegram sendVoice forbidden by recipient privacy settings; falling back to text",
          );
          const textResult = await sendChunkedText(text, "voice fallback text send", {
            replyToAlreadyUsed: singleUseReplyTo && sender.parts.length > 0,
          });
          recordChannelActivity({
            channel: "telegram",
            accountId: account.accountId,
            direction: "outbound",
          });
          return textResult;
        }
        opts.promptContextProjectionPlan?.cursor.invalidate();
        throw error;
      }
      const lastMedia = mediaParts.reduce((_previous, part) => part);
      let mediaDeliveryResult: TelegramSendResult | undefined;
      const recordedMedia = new Set<Message>();
      const recordMediaPromptPart = async (part: TelegramPreparedSendPart, finalPart: boolean) => {
        if (recordedMedia.has(part.result)) {
          return;
        }
        const acceptedParams = toAcceptedThreadScopedParams(part.acceptedParams);
        await recordDeliveredPromptContext(
          {
            message: part.result,
            messageId: part.result.message_id,
            ...(part.plainText ? { text: part.plainText } : {}),
            ...(acceptedParams?.message_thread_id !== undefined
              ? { messageThreadId: acceptedParams.message_thread_id }
              : {}),
          },
          finalPart,
        );
        recordedMedia.add(part.result);
      };
      const recordMediaPromptContext = async (finalPart: boolean) => {
        for (const [index, part] of mediaParts.entries()) {
          await recordMediaPromptPart(part, finalPart && index === mediaParts.length - 1);
        }
      };
      await sender.acceptMany(
        mediaParts,
        async (part) => {
          const deliveredCaption = part.plainText || undefined;
          const acceptedParams = toAcceptedThreadScopedParams(part.acceptedParams);
          const resolvedChatId = String(part.result.chat?.id ?? chatId);
          const meta = {
            ...(deliveredCaption ? { telegramDeliveredText: deliveredCaption } : {}),
            telegramHasInlineKeyboard: part.hasInlineKeyboard,
          };
          telegramCaptionDeliveryMetadata.add(meta);
          recordSentMessage(chatId, part.messageId, cfg, {
            accountId: account.accountId,
            agentId: ownerAgentId,
          });
          await reportDelivery(
            part.messageId,
            resolvedChatId,
            part.result,
            meta,
            "media",
            (delivery) => {
              mediaDeliveryResult = delivery;
            },
          );
          const lastPart = part.result === lastMedia.result;
          if (!needsSeparateText || !lastPart) {
            await recordMediaPromptPart(part, lastPart);
          }
          logTelegramOutboundSendOk({
            accountId: account.accountId,
            chatId: resolvedChatId,
            messageId: String(part.messageId),
            operation,
            deliveryKind,
            messageThreadId: acceptedParams?.message_thread_id,
            replyToMessageId: opts.replyToMessageId,
            silent: opts.silent,
          });
        },
        () => ({
          receipt: buildMediaReceipt(),
          visibleReplySent: true,
        }),
      );
      const mediaMessageId = resolveTelegramMessageIdOrThrow(lastMedia.result, "media send");
      const resolvedChatId = String(lastMedia.result.chat?.id ?? chatId);
      const acceptedMediaParams = toAcceptedThreadScopedParams(lastMedia.acceptedParams);
      recordChannelActivity({
        channel: "telegram",
        accountId: account.accountId,
        direction: "outbound",
      });

      // If text was too long for a caption, send it as a separate follow-up message.
      // Use HTML conversion so markdown renders like captions.
      if (needsSeparateText && followUpText) {
        let textResult: TelegramSendResult;
        try {
          textResult = await sendChunkedText(followUpText, "text follow-up send", {
            replyToAlreadyUsed: singleUseReplyTo,
            beforeFirstAccepted: () => recordMediaPromptContext(false),
          });
        } catch (error) {
          if (!isChannelPartialDeliveryError(error) && isTelegramEmptyContentError(error)) {
            let hasInlineKeyboard = false;
            let keyboardError: unknown;
            if (batchReplyMarkup) {
              try {
                await api.editMessageReplyMarkup(resolvedChatId, mediaMessageId, {
                  reply_markup: batchReplyMarkup,
                });
                hasInlineKeyboard = true;
              } catch (editError) {
                keyboardError = editError;
              }
            }
            await recordMediaPromptContext(true);
            if (keyboardError !== undefined) {
              throw createChannelPartialDeliveryError(keyboardError, {
                messageIds: [String(mediaMessageId)],
                ...(mediaDeliveryResult?.receipt ? { receipt: mediaDeliveryResult.receipt } : {}),
                visibleReplySent: true,
              });
            }
            const finalMediaResult = mediaDeliveryResult ?? {
              messageId: String(mediaMessageId),
              chatId: resolvedChatId,
            };
            if (!hasInlineKeyboard) {
              return finalMediaResult;
            }
            const meta = { ...finalMediaResult.meta, telegramHasInlineKeyboard: true };
            telegramCaptionDeliveryMetadata.add(meta);
            return { ...finalMediaResult, meta };
          }
          await recordMediaPromptContext(false);
          return sender.fail(error);
        }
        const mediaReplyToId = resolveAcceptedReplyToMessageId(acceptedMediaParams)?.toString();
        const receipt = createMessageReceiptFromOutboundResults({
          results: [
            mediaDeliveryResult ?? { messageId: String(mediaMessageId), chatId: resolvedChatId },
            textResult,
          ],
          kind: "text",
        });
        if (mediaReplyToId) {
          receipt.replyToId = mediaReplyToId;
        }
        // Text receipts restart indices; a single follow-up has no nested reply metadata.
        receipt.parts = receipt.parts.map((part, index) => ({
          ...part,
          index,
          ...(index === 0 ? { kind: "media" } : {}),
          ...(mediaReplyToId && (index === 0 || (!textResult.receipt && !singleUseReplyTo))
            ? { replyToId: mediaReplyToId }
            : {}),
        }));
        return {
          ...textResult,
          chatId: resolvedChatId,
          receipt,
        };
      }

      return mediaDeliveryResult?.meta?.telegramHasInlineKeyboard
        ? mediaDeliveryResult
        : {
            messageId: String(mediaMessageId),
            chatId: resolvedChatId,
            ...(mediaDeliveryResult?.receipt ? { receipt: mediaDeliveryResult.receipt } : {}),
          };
    };

    if (mediaUrls.length > 0) {
      if (opts.asVideoNote && mediaUrls.length !== 1) {
        throw new Error("Telegram video notes require exactly one media attachment.");
      }
      try {
        for await (const batch of planTelegramMediaBatches({
          mediaUrls,
          prepare: prepareMedia,
          // Telegram albums cannot carry inline controls. Preserve the first
          // attachment's keyboard through the existing singleton path.
          canGroup: (item) => !replyMarkup && item.mediaSender.label === "photo",
        })) {
          const result = await sendMediaBatch(batch);
          if (batch[0].index + batch.length === mediaUrls.length) {
            if (mediaUrls.length === 1) {
              return result;
            }
            const receipt = buildMediaReceipt();
            const keyboardResult = deliveryResults.find(
              (delivery) => delivery.meta?.telegramHasInlineKeyboard,
            );
            return { ...(keyboardResult ?? result), receipt };
          }
        }
      } catch (error) {
        opts.promptContextProjectionPlan?.cursor.invalidate();
        return sender.fail(error, 0, {
          receipt: buildMediaReceipt(),
          visibleReplySent: true,
        });
      }
    }

    if (!text || !text.trim()) {
      throw new Error("Message must be non-empty for Telegram sends");
    }
    const textResult = await sendChunkedText(text, "text send");
    recordChannelActivity({
      channel: "telegram",
      accountId: account.accountId,
      direction: "outbound",
    });
    return textResult;
  });
}

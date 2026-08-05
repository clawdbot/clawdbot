import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { renderTelegramHtmlText } from "./format.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import {
  prepareTelegramOutboundMedia,
  resolveTelegramOutboundMediaSenders,
  sendTelegramCaptionedMediaWithFallback,
  sendTelegramOutboundMediaWithPhotoFallback,
} from "./outbound-media.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import type { TelegramOutboundPromptContextMessage as TelegramMessageLike } from "./outbound-message-context.js";
import {
  buildTelegramThreadReplyParams,
  resolveTelegramSendThreadSpec,
} from "./reply-parameters.js";
import {
  createRequestWithChatNotFound,
  createTelegramNonIdempotentRequestWithDiag,
  logTelegramOutboundSendOk,
  resolveAcceptedReplyToMessageId,
  resolveAndPersistChatId,
  resolveTelegramApiContext,
  resolveTelegramMessageIdOrThrow,
  sendLogger,
  toAcceptedThreadScopedParams,
  withTelegramApiContextLease,
  withTelegramNativeQuoteFallback,
  type TelegramApiContext,
} from "./send-context.js";
import { isTelegramPhotoLimitError } from "./send-error-predicates.js";
import { createTelegramTextSender } from "./send-message-text.js";
import type { TelegramSendOpts, TelegramSendResult } from "./send-message-types.js";
import {
  buildOutboundMediaLoadOptions,
  getImageMetadata,
  loadWebMedia,
  probeVideoDimensions,
  resolveMarkdownTableMode,
} from "./send.runtime.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { parseTelegramTarget } from "./targets.js";
import { resolveTelegramBotUserIdFromToken } from "./token.js";

const MAX_TELEGRAM_PHOTO_DIMENSION_SUM = 10_000;
const MAX_TELEGRAM_PHOTO_ASPECT_RATIO = 20;

export async function sendMessageTelegram(
  to: string,
  text: string,
  opts: TelegramSendOpts,
): Promise<TelegramSendResult> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    sendMessageTelegramWithContext(to, text, opts, context),
  );
}

async function sendMessageTelegramWithContext(
  to: string,
  text: string,
  opts: TelegramSendOpts,
  apiContext: TelegramApiContext,
): Promise<TelegramSendResult> {
  const { cfg, account, api } = apiContext;
  const botUserId = resolveTelegramBotUserIdFromToken(opts.token || account.token);
  const target = parseTelegramTarget(to);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: to,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });
  const threadSpec = resolveTelegramSendThreadSpec({
    targetMessageThreadId: target.messageThreadId,
    messageThreadId: opts.messageThreadId,
    chatType: target.chatType,
  });
  const reportDelivery = async (
    messageId: string | number,
    deliveredChatId: string | number,
    meta?: TelegramSendResult["meta"],
  ) => {
    await opts.onDeliveryResult?.({
      messageId: String(messageId),
      chatId: String(deliveredChatId),
      ...(meta ? { meta } : {}),
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
    const projection = plan?.cursor.take(plan.finalPart && finalPart);
    const recorded = await recordOutboundMessageForPromptContext({
      cfg,
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
  const mediaUrl = opts.mediaUrl?.trim();
  const mediaMaxBytes =
    opts.maxBytes ??
    (typeof account.config.mediaMaxMb === "number" ? account.config.mediaMaxMb : 100) * 1024 * 1024;
  const replyMarkup = buildInlineKeyboard(opts.buttons);

  const singleUseReplyTo =
    opts.replyToIdSource === "implicit" &&
    opts.replyToMode !== undefined &&
    isSingleUseReplyToMode(opts.replyToMode);
  const buildThreadParams = (includeReplyTo: boolean) =>
    buildTelegramThreadReplyParams({
      thread: threadSpec,
      ...(includeReplyTo
        ? {
            replyToMessageId: opts.replyToMessageId,
            replyQuoteText: opts.quoteText,
            useReplyIdAsQuoteSource: true,
          }
        : {}),
    });
  const requestWithDiag = createTelegramNonIdempotentRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
  });
  const requestWithChatNotFound = createRequestWithChatNotFound({
    requestWithDiag,
    chatId,
    input: to,
  });

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
  const renderHtmlText = (value: string) => renderTelegramHtmlText(value, { textMode, tableMode });
  // Resolve link preview setting from config (default: enabled).
  const linkPreviewEnabled = account.config.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };

  const { sendChunkedText } = createTelegramTextSender({
    cfg,
    account,
    api,
    chatId,
    opts,
    replyMarkup,
    reportDelivery,
    recordDeliveredPromptContext,
    singleUseReplyTo,
    buildThreadParams,
    requestWithChatNotFound,
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

  if (mediaUrl) {
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
      text,
      textMode,
      tableMode,
      forceDocument: opts.forceDocument,
      asVideoNote: opts.asVideoNote,
    });
    const sendImageAsPhoto =
      mediaPlan.deliveryKind !== "image" ||
      mediaPlan.isGif ||
      (await shouldSendTelegramImageAsPhoto(media.buffer));
    const { sender: mediaSender, documentSender } = resolveTelegramOutboundMediaSenders({
      api,
      chatId,
      media,
      plan: mediaPlan,
      forceDocument: opts.forceDocument,
      asVoice: opts.asVoice,
      sendImageAsPhoto,
    });
    const { caption, htmlCaption, plainCaption, followUpText } = mediaPlan;
    // If text exceeds Telegram's caption limit, send media without caption
    // then send text as a separate follow-up message.
    const needsSeparateText = Boolean(followUpText);
    // When splitting, put reply_markup only on the follow-up text (the "main" content),
    // not on the media message.
    const mediaThreadParams = buildThreadParams(true);
    const mediaUsedReplyTo = resolveAcceptedReplyToMessageId(mediaThreadParams) !== undefined;
    const baseMediaParams = {
      ...mediaThreadParams,
      ...(!needsSeparateText && replyMarkup ? { reply_markup: replyMarkup } : {}),
    };
    const videoDimensions =
      mediaPlan.deliveryKind === "video" && !mediaPlan.isVideoNote
        ? await probeVideoDimensions(media.buffer)
        : undefined;
    const mediaParams = {
      ...(htmlCaption ? { caption: htmlCaption, parse_mode: "HTML" as const } : {}),
      ...baseMediaParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
      ...(videoDimensions ? { width: videoDimensions.width, height: videoDimensions.height } : {}),
    };
    const sendMedia = async (
      label: string,
      sender: (effectiveParams: Record<string, unknown>) => Promise<TelegramMessageLike>,
    ) => {
      return await sendTelegramCaptionedMediaWithFallback({
        operation: label,
        requestParams: mediaParams,
        plainCaption: htmlCaption ? plainCaption : undefined,
        ...(label === "photo"
          ? { shouldLog: (error: unknown) => !isTelegramPhotoLimitError(error) }
          : {}),
        send: (requestParams, shouldLog) =>
          withTelegramNativeQuoteFallback({
            label,
            requestParams,
            request: (effectiveParams, effectiveLabel) =>
              requestWithChatNotFound(
                () => sender(effectiveParams),
                effectiveLabel,
                shouldLog ? { shouldLog } : undefined,
              ),
          }),
      });
    };

    let mediaDelivery: Awaited<ReturnType<typeof sendMedia>>;
    let deliveredMediaSender: typeof mediaSender;
    try {
      const delivery = await sendTelegramOutboundMediaWithPhotoFallback({
        sender: mediaSender,
        documentSender,
        send: (sender) => sendMedia(sender.label, sender.send),
      });
      mediaDelivery = delivery.result;
      deliveredMediaSender = delivery.sender;
    } catch (error) {
      opts.promptContextProjectionPlan?.cursor.invalidate();
      throw error;
    }
    const result = mediaDelivery.result;
    const acceptedMediaParams = toAcceptedThreadScopedParams(mediaDelivery.acceptedParams);
    const mediaMessageId = resolveTelegramMessageIdOrThrow(result, "media send");
    const resolvedChatId = String(result?.chat?.id ?? chatId);
    recordSentMessage(chatId, mediaMessageId, cfg);
    await reportDelivery(mediaMessageId, resolvedChatId, {
      ...(caption ? { telegramDeliveredText: caption } : {}),
      telegramHasInlineKeyboard: !needsSeparateText && Boolean(replyMarkup),
    });
    await recordDeliveredPromptContext(
      {
        message: result,
        messageId: mediaMessageId,
        ...(caption ? { text: caption } : {}),
        ...(acceptedMediaParams?.message_thread_id !== undefined
          ? { messageThreadId: acceptedMediaParams.message_thread_id }
          : {}),
      },
      !needsSeparateText,
    );
    logTelegramOutboundSendOk({
      accountId: account.accountId,
      chatId: resolvedChatId,
      messageId: String(mediaMessageId),
      operation: deliveredMediaSender.operation,
      deliveryKind: deliveredMediaSender.label,
      messageThreadId: acceptedMediaParams?.message_thread_id,
      replyToMessageId: opts.replyToMessageId,
      silent: opts.silent,
    });
    recordChannelActivity({
      channel: "telegram",
      accountId: account.accountId,
      direction: "outbound",
    });

    // If text was too long for a caption, send it as a separate follow-up message.
    // Use HTML conversion so markdown renders like captions.
    if (needsSeparateText && followUpText) {
      const textResult = await sendChunkedText(followUpText, "text follow-up send", {
        replyToAlreadyUsed: singleUseReplyTo && mediaUsedReplyTo,
      });
      const mediaReplyToId = resolveAcceptedReplyToMessageId(acceptedMediaParams)?.toString();
      const receipt = createMessageReceiptFromOutboundResults({
        results: [{ messageId: String(mediaMessageId), chatId: resolvedChatId }, textResult],
        kind: "text",
        ...(acceptedMediaParams?.message_thread_id !== undefined
          ? { threadId: String(acceptedMediaParams.message_thread_id) }
          : {}),
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

    return { messageId: String(mediaMessageId), chatId: resolvedChatId };
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
}

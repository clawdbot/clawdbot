import * as grammy from "grammy";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { splitTelegramCaption } from "./caption.js";
import { renderTelegramHtmlText, telegramHtmlToPlainTextFallback } from "./format.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
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
  withTelegramHtmlParseFallback,
  withTelegramNativeQuoteFallback,
  type TelegramApiContext,
  type TelegramThreadScopedParams,
} from "./send-context.js";
import { createTelegramTextSender } from "./send-message-text.js";
import type { TelegramSendOpts, TelegramSendResult } from "./send-message-types.js";
import {
  buildOutboundMediaLoadOptions,
  getImageMetadata,
  isGifMedia,
  kindFromMime,
  loadWebMedia,
  type MediaKind,
  probeVideoDimensions,
  resolveMarkdownTableMode,
} from "./send.runtime.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { parseTelegramTarget } from "./targets.js";
import { resolveTelegramBotUserIdFromToken } from "./token.js";
import { resolveTelegramVoiceSend } from "./voice.js";

const InputFileCtor = grammy.InputFile;
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
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaReadFile: opts.mediaReadFile,
        optimizeImages: opts.forceDocument ? false : undefined,
      }),
    );
    const kind = kindFromMime(media.contentType ?? undefined);
    const isGif = isGifMedia({
      contentType: media.contentType,
      fileName: media.fileName,
    });

    let sendImageAsPhoto = true;
    const deliveryKind =
      opts.forceDocument === true && (kind === "image" || kind === "video") ? "document" : kind;
    if (opts.asVideoNote === true && deliveryKind !== "video") {
      throw new Error("Telegram video notes require video media.");
    }
    if (deliveryKind === "image" && !isGif) {
      sendImageAsPhoto = await shouldSendTelegramImageAsPhoto(media.buffer);
    }
    const isVideoNote = deliveryKind === "video" && opts.asVideoNote === true;
    const fileName =
      media.fileName ?? (isGif ? "animation.gif" : inferFilename(kind ?? "document")) ?? "file";
    const file = new InputFileCtor(media.buffer, fileName);
    let caption: string | undefined;
    let followUpText: string | undefined;

    if (isVideoNote) {
      caption = undefined;
      followUpText = text.trim() ? text : undefined;
    } else {
      const split = splitTelegramCaption(text);
      caption = split.caption;
      followUpText = split.followUpText;
    }
    const htmlCaption = caption ? renderHtmlText(caption) : undefined;
    const plainCaption =
      caption && textMode === "html" ? telegramHtmlToPlainTextFallback(caption) : caption;
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
      deliveryKind === "video" && !isVideoNote
        ? await probeVideoDimensions(media.buffer)
        : undefined;
    const mediaParams = {
      ...(htmlCaption ? { caption: htmlCaption, parse_mode: "HTML" as const } : {}),
      ...baseMediaParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
      ...(videoDimensions ? { width: videoDimensions.width, height: videoDimensions.height } : {}),
    };
    const plainMediaParams = {
      ...(plainCaption ? { caption: plainCaption } : {}),
      ...baseMediaParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
      ...(videoDimensions ? { width: videoDimensions.width, height: videoDimensions.height } : {}),
    };
    const sendMedia = async (
      label: string,
      sender: (
        effectiveParams: TelegramThreadScopedParams | undefined,
      ) => Promise<TelegramMessageLike>,
    ) => {
      const requestMedia = (requestParams: TelegramThreadScopedParams, retryLabel: string) =>
        withTelegramNativeQuoteFallback({
          label: retryLabel,
          requestParams,
          request: (effectiveParams, effectiveLabel) =>
            requestWithChatNotFound(
              () => sender(effectiveParams as TelegramThreadScopedParams),
              effectiveLabel,
            ),
        });
      if (!htmlCaption || !plainCaption) {
        return await requestMedia(mediaParams, label);
      }
      // Same contract as text sends: Telegram HTML parse failures retry once
      // with the already visible plain caption so final media replies survive.
      return await withTelegramHtmlParseFallback({
        label,
        verbose: opts.verbose,
        requestHtml: (retryLabel) => requestMedia(mediaParams, retryLabel),
        requestPlain: (retryLabel) => requestMedia(plainMediaParams, retryLabel),
      });
    };

    const mediaSender = (() => {
      if (isGif && deliveryKind !== "document") {
        return {
          label: "animation",
          sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
            api.sendAnimation(
              chatId,
              file,
              effectiveParams as Parameters<typeof api.sendAnimation>[2],
            ) as Promise<TelegramMessageLike>,
        };
      }
      if (deliveryKind === "image" && !isGif && sendImageAsPhoto) {
        return {
          label: "photo",
          sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
            api.sendPhoto(
              chatId,
              file,
              effectiveParams as Parameters<typeof api.sendPhoto>[2],
            ) as Promise<TelegramMessageLike>,
        };
      }
      if (deliveryKind === "video") {
        if (isVideoNote) {
          return {
            label: "video_note",
            sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
              api.sendVideoNote(
                chatId,
                file,
                effectiveParams as Parameters<typeof api.sendVideoNote>[2],
              ) as Promise<TelegramMessageLike>,
          };
        }
        return {
          label: "video",
          sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
            api.sendVideo(
              chatId,
              file,
              effectiveParams as Parameters<typeof api.sendVideo>[2],
            ) as Promise<TelegramMessageLike>,
        };
      }
      if (kind === "audio") {
        const { useVoice } = resolveTelegramVoiceSend({
          wantsVoice: opts.asVoice === true, // default false (backward compatible)
          contentType: media.contentType,
          fileName,
          logFallback: logVerbose,
        });
        if (useVoice) {
          return {
            label: "voice",
            sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
              api.sendVoice(
                chatId,
                file,
                effectiveParams as Parameters<typeof api.sendVoice>[2],
              ) as Promise<TelegramMessageLike>,
          };
        }
        return {
          label: "audio",
          sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
            api.sendAudio(
              chatId,
              file,
              effectiveParams as Parameters<typeof api.sendAudio>[2],
            ) as Promise<TelegramMessageLike>,
        };
      }
      return {
        label: "document",
        sender: (effectiveParams: TelegramThreadScopedParams | undefined) =>
          api.sendDocument(
            chatId,
            file,
            (opts.forceDocument
              ? { ...effectiveParams, disable_content_type_detection: true }
              : effectiveParams) as Parameters<typeof api.sendDocument>[2],
          ) as Promise<TelegramMessageLike>,
      };
    })();

    let mediaDelivery: Awaited<ReturnType<typeof sendMedia>>;
    try {
      mediaDelivery = await sendMedia(mediaSender.label, mediaSender.sender);
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
      operation: `send${mediaSender.label
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("")}`,
      deliveryKind: mediaSender.label,
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
      return {
        ...textResult,
        chatId: resolvedChatId,
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

function inferFilename(kind: MediaKind) {
  switch (kind) {
    case "image":
      return "image.jpg";
    case "video":
      return "video.mp4";
    case "audio":
      return "audio.ogg";
    default:
      return "file.bin";
  }
}

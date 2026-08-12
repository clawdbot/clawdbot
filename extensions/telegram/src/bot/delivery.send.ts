import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { createChannelApiRetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "../api-logging.js";
import { isSafeToRetrySendError, isTelegramRateLimitError } from "../network-errors.js";
import {
  buildTelegramSendParams,
  getTelegramNativeQuoteReplyMessageId,
  isTelegramQuoteParamError,
} from "../reply-parameters.js";
import { TELEGRAM_OUTBOUND_RETRY_AFTER_CAP_MS } from "../retry-after.js";
import type { TelegramRichBlocksDegradationReason } from "../rich-block-model.js";
import {
  getTelegramRichRawApi,
  removeTelegramRichNativeQuoteParam,
  toTelegramRichMessageContextParams,
  type TelegramInputRichMessage,
} from "../rich-message.js";
import { isTelegramEmptyContentError, isTelegramHtmlParseError } from "../rich-plain-fallback.js";
import { withTelegramNativeQuoteFallback } from "../send-context.js";
import { reportTelegramProviderDelivery } from "../send-outbound.js";
import { buildInlineKeyboard } from "../send.js";
import {
  deliverTelegramTextPage,
  planTelegramTextDeliveryPages,
} from "../telegram-text-delivery.js";
import type { TelegramThreadSpec } from "./helpers.js";

export { buildTelegramSendParams } from "../reply-parameters.js";

function createTelegramDeliverySendRetry() {
  return createChannelApiRetryRunner({
    shouldRetry: (err) => isSafeToRetrySendError(err) || isTelegramRateLimitError(err),
    strictShouldRetry: true,
    retryAfterMaxDelayMs: TELEGRAM_OUTBOUND_RETRY_AFTER_CAP_MS,
  });
}

export async function sendTelegramWithThreadFallback<T>(params: {
  operation: string;
  runtime: RuntimeEnv;
  requestParams: Record<string, unknown>;
  send: (effectiveParams: Record<string, unknown>) => Promise<T>;
  removeNativeQuoteParam?: (requestParams: Record<string, unknown>) => Record<string, unknown>;
  shouldLog?: (err: unknown) => boolean;
}): Promise<T> {
  const requestWithRetry = createTelegramDeliverySendRetry();
  const { result } = await withTelegramNativeQuoteFallback({
    label: params.operation,
    requestParams: params.requestParams,
    removeNativeQuoteParam: params.removeNativeQuoteParam,
    request: (requestParams, operation) =>
      withTelegramApiErrorLogging({
        operation,
        runtime: params.runtime,
        shouldLog: (error) =>
          (params.shouldLog?.(error) ?? true) &&
          !(
            getTelegramNativeQuoteReplyMessageId(requestParams) && isTelegramQuoteParamError(error)
          ),
        fn: () => requestWithRetry(() => params.send(requestParams), operation),
      }),
  });
  return result;
}

export async function sendTelegramText(
  bot: Bot,
  chatId: string,
  text: string,
  runtime: RuntimeEnv,
  opts?: {
    replyToMessageId?: number;
    replyQuoteMessageId?: number;
    replyQuoteText?: string;
    replyQuotePosition?: number;
    replyQuoteEntities?: unknown[];
    thread?: TelegramThreadSpec | null;
    textMode?: "markdown" | "html";
    plainText?: string;
    richMessages?: boolean;
    richMessage?: TelegramInputRichMessage;
    richDegradationReasons?: readonly TelegramRichBlocksDegradationReason[];
    linkPreview?: boolean;
    tableMode?: MarkdownTableMode;
    silent?: boolean;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
    onAcceptedMessage?: (messageId: number, plainText: string) => Promise<void> | void;
  },
): Promise<number> {
  const baseParams = buildTelegramSendParams({
    replyToMessageId: opts?.replyToMessageId,
    replyQuoteMessageId: opts?.replyQuoteMessageId,
    replyQuoteText: opts?.replyQuoteText,
    replyQuotePosition: opts?.replyQuotePosition,
    replyQuoteEntities: opts?.replyQuoteEntities,
    thread: opts?.thread,
    silent: opts?.silent,
  });
  const fallbackText = opts?.plainText ?? text;
  const acceptProviderMessage = async (message: Message) => {
    if (opts?.thread?.id !== undefined) {
      await reportTelegramProviderDelivery({
        message,
        messageId: message.message_id,
        fallbackChatId: chatId,
        successfulSendThread: opts.thread,
      });
    }
    return message.message_id;
  };
  const pages = planTelegramTextDeliveryPages({
    text,
    maxChars: text.length || 1,
    tableMode: opts?.tableMode,
    richMessages: opts?.richMessages,
    richMessage: opts?.richMessage,
    degradationReasons: opts?.richDegradationReasons,
    skipEntityDetection: opts?.linkPreview === false,
    ...(opts?.textMode === "html" ? { textMode: "html" as const } : {}),
  });
  const page = pages[0];
  if (!page || (!page.richMessage && !page.htmlText?.trim() && !fallbackText.trim())) {
    throw new Error("telegram text delivery failed: empty formatted text and empty plain fallback");
  }
  page.plainText = fallbackText;
  const linkPreviewOptions = opts?.linkPreview === false ? { is_disabled: true } : undefined;
  const withoutReply = (requestParams: Record<string, unknown>) => {
    const next = { ...requestParams };
    delete next.reply_parameters;
    delete next.reply_to_message_id;
    return next;
  };
  const sendPlainOrHtml = async (
    messageText: string,
    params: {
      html: boolean;
      fallback?: { index: number; count: number };
      operation?: string;
    },
  ) => {
    const requestParams =
      params.fallback && params.fallback.index > 0 ? withoutReply(baseParams) : baseParams;
    const isFinalFallback = !params.fallback || params.fallback.index === params.fallback.count - 1;
    return await sendTelegramWithThreadFallback({
      operation: params.operation ?? "sendMessage",
      runtime,
      requestParams,
      shouldLog: (error) => !isTelegramHtmlParseError(error) && !isTelegramEmptyContentError(error),
      send: (effectiveParams) =>
        bot.api.sendMessage(chatId, messageText, {
          ...(params.html ? { parse_mode: "HTML" as const } : {}),
          ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
          ...(isFinalFallback && opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...effectiveParams,
        }),
    });
  };
  const delivered = await deliverTelegramTextPage({
    page,
    context: page.richMessage ? "sendRichMessage" : "sendMessage",
    warn: (message) => runtime.log?.(message),
    sender: {
      sendPlain: (plainText, fallback, label) =>
        sendPlainOrHtml(plainText, {
          html: false,
          ...(fallback ? { fallback } : {}),
          ...(label ? { operation: label } : {}),
        }),
      sendHtml: (htmlText) => sendPlainOrHtml(htmlText, { html: true }),
      sendRich: (richMessage) =>
        sendTelegramWithThreadFallback({
          operation: "sendRichMessage",
          runtime,
          requestParams: toTelegramRichMessageContextParams(baseParams),
          removeNativeQuoteParam: removeTelegramRichNativeQuoteParam,
          send: (effectiveParams) =>
            getTelegramRichRawApi(bot.api).sendRichMessage({
              chat_id: chatId,
              rich_message: richMessage,
              ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
              ...effectiveParams,
            }),
        }),
    },
  });
  let firstDeliveredMessageId: number | undefined;
  for (const accepted of delivered) {
    const messageId = await acceptProviderMessage(accepted.result);
    firstDeliveredMessageId ??= messageId;
    runtime.log?.(`telegram text delivery ok chat=${chatId} message=${messageId}`);
    await opts?.onAcceptedMessage?.(messageId, accepted.page.plainText);
  }
  return firstDeliveredMessageId!;
}

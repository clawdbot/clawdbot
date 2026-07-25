// Telegram plugin module implements delivery.send behavior.
import type { Bot } from "grammy";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { createChannelApiRetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTelegramApiErrorLogging } from "../api-logging.js";
import { markdownToTelegramHtml } from "../format.js";
import { isSafeToRetrySendError, isTelegramRateLimitError } from "../network-errors.js";
import {
  buildTelegramSendParams,
  getTelegramNativeQuoteReplyMessageId,
  isTelegramQuoteParamError,
  removeTelegramNativeQuoteParam,
} from "../reply-parameters.js";
import { TELEGRAM_OUTBOUND_RETRY_AFTER_CAP_MS } from "../retry-after.js";
import type { TelegramRichBlocksDegradationReason } from "../rich-block-model.js";
import {
  buildTelegramRichMarkdownPlan,
  getTelegramRichRawApi,
  isEmptyTelegramRichMessage,
  removeTelegramRichNativeQuoteParam,
  toTelegramRichMessageContextParams,
  type TelegramInputRichMessage,
} from "../rich-message.js";
import {
  buildTelegramPlainFallbackPlan,
  isTelegramHtmlParseError,
  warnTelegramRichBlocksDegradations,
} from "../rich-plain-fallback.js";
import { buildInlineKeyboard } from "../send.js";
import type { TelegramThreadSpec } from "./helpers.js";

export { buildTelegramSendParams } from "../reply-parameters.js";

const EMPTY_TEXT_ERR_RE = /message text is empty/i;
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
  thread?: TelegramThreadSpec | null;
  requestParams: Record<string, unknown>;
  send: (effectiveParams: Record<string, unknown>) => Promise<T>;
  removeNativeQuoteParam?: (requestParams: Record<string, unknown>) => Record<string, unknown>;
  shouldLog?: (err: unknown) => boolean;
}): Promise<T> {
  const hasNativeQuote = getTelegramNativeQuoteReplyMessageId(params.requestParams) != null;
  const shouldSuppressFirstErrorLog = (err: unknown) =>
    hasNativeQuote && isTelegramQuoteParamError(err);
  const mergedShouldLog = params.shouldLog
    ? (err: unknown) => params.shouldLog!(err) && !shouldSuppressFirstErrorLog(err)
    : (err: unknown) => !shouldSuppressFirstErrorLog(err);
  const requestWithRetry = createTelegramDeliverySendRetry();
  const runLoggedSend = (
    operation: string,
    requestParams: Record<string, unknown>,
    shouldLog?: (err: unknown) => boolean,
  ) =>
    withTelegramApiErrorLogging({
      operation,
      runtime: params.runtime,
      ...(shouldLog ? { shouldLog } : {}),
      fn: () => requestWithRetry(() => params.send(requestParams), operation),
    });

  try {
    return await runLoggedSend(params.operation, params.requestParams, mergedShouldLog);
  } catch (err) {
    if (hasNativeQuote && isTelegramQuoteParamError(err)) {
      params.runtime.log?.(
        `telegram ${params.operation}: native quote rejected; retrying with legacy reply_to_message_id`,
      );
      return await sendTelegramWithThreadFallback({
        ...params,
        operation: `${params.operation} (legacy reply retry)`,
        requestParams: (params.removeNativeQuoteParam ?? removeTelegramNativeQuoteParam)(
          params.requestParams,
        ),
      });
    }
    throw err;
  }
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
  const textMode = opts?.textMode ?? "markdown";
  // Add link_preview_options when link preview is disabled.
  const linkPreviewEnabled = opts?.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };
  const htmlText = textMode === "html" ? text : markdownToTelegramHtml(text);
  const fallbackText = opts?.plainText ?? text;
  const hasFallbackText = fallbackText.trim().length > 0;
  const sendPlainFallback = async (plainText: string = fallbackText) => {
    const res = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      thread: opts?.thread,
      requestParams: baseParams,
      send: (effectiveParams) =>
        bot.api.sendMessage(chatId, plainText, {
          ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...effectiveParams,
        }),
    });
    runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id} (plain)`);
    return res.message_id;
  };

  // Caller-authored HTML keeps legacy parse_mode HTML semantics (literal
  // newlines, tag-aware chunking) even on rich accounts.
  if (opts?.richMessages === true && textMode !== "html") {
    const richPlan = opts.richMessage
      ? {
          richMessage: opts.richMessage,
          plainText: fallbackText,
          degradationReasons: opts.richDegradationReasons ?? [],
        }
      : buildTelegramRichMarkdownPlan(text, {
          skipEntityDetection: opts.linkPreview === false,
          tableMode: opts.tableMode,
        });
    warnTelegramRichBlocksDegradations({
      context: "sendRichMessage",
      reasons: richPlan.degradationReasons,
      warn: (message) => runtime.log?.(message),
    });
    if (isEmptyTelegramRichMessage(richPlan.richMessage)) {
      if (!hasFallbackText) {
        throw new Error(
          "telegram sendRichMessage failed: empty rich text and empty plain fallback",
        );
      }
      runtime.log?.("telegram sendRichMessage rendered empty; falling back to plain text");
      return await sendPlainFallback();
    }
    try {
      const res = await sendTelegramWithThreadFallback({
        operation: "sendRichMessage",
        runtime,
        thread: opts.thread,
        requestParams: toTelegramRichMessageContextParams(baseParams),
        removeNativeQuoteParam: removeTelegramRichNativeQuoteParam,
        send: (effectiveParams) =>
          getTelegramRichRawApi(bot.api).sendRichMessage({
            chat_id: chatId,
            rich_message: richPlan.richMessage,
            ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
            ...effectiveParams,
          }),
      });
      runtime.log?.(`telegram sendRichMessage ok chat=${chatId} message=${res.message_id}`);
      return res.message_id;
    } catch (err) {
      const fallbackPlan = buildTelegramPlainFallbackPlan({
        plainText: richPlan.plainText || fallbackText,
        err,
        context: "sendRichMessage",
        warn: (message) => runtime.log?.(message),
      });
      if (!fallbackPlan || !hasFallbackText) {
        throw err;
      }
      return await sendPlainFallback(fallbackPlan.plainText);
    }
  }

  // Markdown can render to empty HTML for syntax-only chunks; recover with plain text.
  if (!htmlText.trim()) {
    if (!hasFallbackText) {
      throw new Error("telegram sendMessage failed: empty formatted text and empty plain fallback");
    }
    return await sendPlainFallback();
  }
  try {
    const res = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      thread: opts?.thread,
      requestParams: baseParams,
      shouldLog: (err) => {
        const errText = formatErrorMessage(err);
        return !isTelegramHtmlParseError(err) && !EMPTY_TEXT_ERR_RE.test(errText);
      },
      send: (effectiveParams) =>
        bot.api.sendMessage(chatId, htmlText, {
          parse_mode: "HTML",
          ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...effectiveParams,
        }),
    });
    runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id}`);
    return res.message_id;
  } catch (err) {
    const errText = formatErrorMessage(err);
    if (isTelegramHtmlParseError(err) || EMPTY_TEXT_ERR_RE.test(errText)) {
      if (!hasFallbackText) {
        throw err;
      }
      runtime.log?.(`telegram formatted send failed; retrying without formatting: ${errText}`);
      return await sendPlainFallback();
    }
    throw err;
  }
}

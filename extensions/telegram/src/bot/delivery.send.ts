import { type Bot, GrammyError } from "grammy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTelegramApiErrorLogging } from "../api-logging.js";
import { markdownToTelegramHtml } from "../format.js";
import { normalizeTelegramReplyToMessageId } from "../outbound-params.js";
import { buildInlineKeyboard } from "../send.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./helpers.js";

const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const EMPTY_TEXT_ERR_RE = /message text is empty/i;
const THREAD_NOT_FOUND_RE = /message thread not found/i;
const GrammyErrorCtor: typeof GrammyError | undefined =
  typeof GrammyError === "function" ? GrammyError : undefined;

function isTelegramThreadNotFoundError(err: unknown): boolean {
  if (GrammyErrorCtor && err instanceof GrammyErrorCtor) {
    return THREAD_NOT_FOUND_RE.test(err.description);
  }
  return THREAD_NOT_FOUND_RE.test(formatErrorMessage(err));
}

function hasMessageThreadIdParam(params: Record<string, unknown> | undefined): boolean {
  if (!params) {
    return false;
  }
  return typeof params.message_thread_id === "number";
}

function removeMessageThreadIdParam(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!params) {
    return {};
  }
  const { message_thread_id: _ignored, ...rest } = params;
  return rest;
}

export async function sendTelegramWithThreadFallback<T>(params: {
  operation: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  requestParams: Record<string, unknown>;
  send: (effectiveParams: Record<string, unknown>) => Promise<T>;
  shouldLog?: (err: unknown) => boolean;
}): Promise<T> {
  const allowThreadlessRetry = params.thread?.scope === "dm";
  const hasThreadId = hasMessageThreadIdParam(params.requestParams);
  const shouldSuppressFirstErrorLog = (err: unknown) =>
    allowThreadlessRetry && hasThreadId && isTelegramThreadNotFoundError(err);
  const mergedShouldLog = params.shouldLog
    ? (err: unknown) => params.shouldLog!(err) && !shouldSuppressFirstErrorLog(err)
    : (err: unknown) => !shouldSuppressFirstErrorLog(err);

  try {
    return await withTelegramApiErrorLogging({
      operation: params.operation,
      runtime: params.runtime,
      shouldLog: mergedShouldLog,
      fn: () => params.send(params.requestParams),
    });
  } catch (err) {
    if (!allowThreadlessRetry || !hasThreadId || !isTelegramThreadNotFoundError(err)) {
      throw err;
    }
    const retryParams = removeMessageThreadIdParam(params.requestParams);
    params.runtime.log?.(
      `telegram ${params.operation}: message thread not found; retrying without message_thread_id`,
    );
    return await withTelegramApiErrorLogging({
      operation: `${params.operation} (threadless retry)`,
      runtime: params.runtime,
      fn: () => params.send(retryParams),
    });
  }
}

export function buildTelegramSendParams(opts?: {
  replyToMessageId?: number;
  thread?: TelegramThreadSpec | null;
  silent?: boolean;
}): Record<string, unknown> {
  const threadParams = buildTelegramThreadParams(opts?.thread);
  const params: Record<string, unknown> = {};
  const replyToMessageId = normalizeTelegramReplyToMessageId(opts?.replyToMessageId);
  if (replyToMessageId != null) {
    params.reply_to_message_id = replyToMessageId;
    params.allow_sending_without_reply = true;
  }
  if (threadParams) {
    params.message_thread_id = threadParams.message_thread_id;
  }
  if (opts?.silent === true) {
    params.disable_notification = true;
  }
  return params;
}

export async function sendTelegramText(
  bot: Bot,
  chatId: string,
  text: string,
  runtime: RuntimeEnv,
  opts?: {
    replyToMessageId?: number;
    replyQuoteText?: string;
    thread?: TelegramThreadSpec | null;
    textMode?: "markdown" | "html";
    plainText?: string;
    linkPreview?: boolean;
    silent?: boolean;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  },
): Promise<number> {
  const baseParams = buildTelegramSendParams({
    replyToMessageId: opts?.replyToMessageId,
    thread: opts?.thread,
    silent: opts?.silent,
  });
  // Add link_preview_options when link preview is disabled.
  const linkPreviewEnabled = opts?.linkPreview ?? true;
  const linkPreviewOptions = linkPreviewEnabled ? undefined : { is_disabled: true };
  const textMode = opts?.textMode ?? "markdown";
  const htmlText = textMode === "html" ? text : markdownToTelegramHtml(text);
  const fallbackText = opts?.plainText ?? text;
  const hasFallbackText = fallbackText.trim().length > 0;
  const sendPlainFallback = async () => {
    const res = await sendTelegramWithThreadFallback({
      operation: "sendMessage",
      runtime,
      thread: opts?.thread,
      requestParams: baseParams,
      send: (effectiveParams) =>
        bot.api.sendMessage(chatId, fallbackText, {
          ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
          ...effectiveParams,
        }),
    });
    runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id} (plain)`);
    return res.message_id;
  };

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
        return !PARSE_ERR_RE.test(errText) && !EMPTY_TEXT_ERR_RE.test(errText);
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
    if (PARSE_ERR_RE.test(errText) || EMPTY_TEXT_ERR_RE.test(errText)) {
      if (!hasFallbackText) {
        throw err;
      }
      runtime.log?.(`telegram formatted send failed; retrying without formatting: ${errText}`);
      return await sendPlainFallback();
    }
    throw err;
  }
}

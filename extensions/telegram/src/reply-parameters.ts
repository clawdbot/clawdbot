import type { MessageEntity } from "@grammyjs/types";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import { normalizeTelegramReplyToMessageId } from "./outbound-params.js";

type TelegramReplyParameters = {
  message_id: number;
  allow_sending_without_reply: true;
  quote?: string;
  quote_position?: number;
  quote_entities?: MessageEntity[];
};

type TelegramThreadReplyParams = {
  message_thread_id?: number;
  reply_parameters?: TelegramReplyParameters;
  reply_to_message_id?: number;
  allow_sending_without_reply?: true;
};

export function resolveTelegramSendThreadSpec(params: {
  targetMessageThreadId?: number;
  messageThreadId?: number;
  chatType?: "direct" | "group" | "unknown";
}): TelegramThreadSpec | undefined {
  const messageThreadId =
    params.messageThreadId != null ? params.messageThreadId : params.targetMessageThreadId;
  if (messageThreadId == null) {
    return undefined;
  }
  // Telegram supports DM topics; keep direct chat thread IDs and rely on
  // thread-not-found retry fallback when a plain DM rejects them.
  return {
    id: messageThreadId,
    scope: params.chatType === "direct" ? "dm" : "forum",
  };
}

export function buildTelegramThreadReplyParams(opts?: {
  thread?: TelegramThreadSpec | null;
  replyToMessageId?: number;
  replyQuoteMessageId?: number;
  replyQuoteText?: string;
  replyQuotePosition?: number;
  replyQuoteEntities?: unknown[];
  useReplyIdAsQuoteSource?: boolean;
}): TelegramThreadReplyParams {
  const params: TelegramThreadReplyParams = {};
  const threadParams = buildTelegramThreadParams(opts?.thread);
  if (threadParams) {
    params.message_thread_id = threadParams.message_thread_id;
  }

  const replyToMessageId = normalizeTelegramReplyToMessageId(opts?.replyToMessageId);
  if (replyToMessageId == null) {
    return params;
  }

  const defaultQuoteMessageId =
    opts?.useReplyIdAsQuoteSource === true ? replyToMessageId : undefined;
  const replyQuoteMessageId = normalizeTelegramReplyToMessageId(
    opts?.replyQuoteMessageId ?? defaultQuoteMessageId,
  );
  const replyQuoteTextRaw =
    replyQuoteMessageId === replyToMessageId ? opts?.replyQuoteText : undefined;
  const replyQuoteText = replyQuoteTextRaw?.trim() ? replyQuoteTextRaw : undefined;
  if (!replyQuoteText) {
    params.reply_to_message_id = replyToMessageId;
    params.allow_sending_without_reply = true;
    return params;
  }

  const replyParameters: TelegramReplyParameters = {
    message_id: replyToMessageId,
    quote: replyQuoteText,
    allow_sending_without_reply: true,
  };
  if (typeof opts?.replyQuotePosition === "number" && Number.isFinite(opts.replyQuotePosition)) {
    replyParameters.quote_position = Math.trunc(opts.replyQuotePosition);
  }
  if (Array.isArray(opts?.replyQuoteEntities) && opts.replyQuoteEntities.length > 0) {
    replyParameters.quote_entities = opts.replyQuoteEntities as MessageEntity[];
  }
  params.reply_parameters = replyParameters;
  return params;
}

export function buildTelegramSendParams(opts?: {
  replyToMessageId?: number;
  replyQuoteMessageId?: number;
  replyQuoteText?: string;
  replyQuotePosition?: number;
  replyQuoteEntities?: unknown[];
  thread?: TelegramThreadSpec | null;
  silent?: boolean;
  useReplyIdAsQuoteSource?: boolean;
}): Record<string, unknown> {
  const params: Record<string, unknown> = { ...buildTelegramThreadReplyParams(opts) };
  if (opts?.silent === true) {
    params.disable_notification = true;
  }
  return params;
}

export function getTelegramNativeQuoteReplyMessageId(
  params: Record<string, unknown> | undefined,
): number | undefined {
  const replyParameters = params?.reply_parameters;
  if (!replyParameters || typeof replyParameters !== "object") {
    return undefined;
  }
  const messageId = (replyParameters as { message_id?: unknown }).message_id;
  return typeof messageId === "number" && Number.isFinite(messageId) ? messageId : undefined;
}

export function removeTelegramNativeQuoteParam(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!params) {
    return {};
  }
  const replyMessageId = getTelegramNativeQuoteReplyMessageId(params);
  const { reply_parameters: _ignored, ...rest } = params;
  if (replyMessageId != null) {
    rest.reply_to_message_id = replyMessageId;
    rest.allow_sending_without_reply = true;
  }
  return rest;
}

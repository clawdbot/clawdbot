import {
  resolveTelegramApiContext,
  withTelegramApiContextLease,
  type TelegramApiContext,
} from "./send-context.js";
import type {
  TelegramSendOpts,
  TelegramSendResult,
  TelegramThreadedSendOpts,
} from "./send-message-types.js";
import { finalizeTelegramOutbound, prepareTelegramOutbound } from "./send-outbound.js";
import { normalizePollInput, type PollInput } from "./send.runtime.js";

type TelegramSendPollParams = Parameters<TelegramApiContext["api"]["sendPoll"]>[3];

/**
 * Send a sticker to a Telegram chat by file_id.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param fileId - Telegram file_id of the sticker to send
 * @param opts - Optional configuration
 */
export async function sendStickerTelegram(
  to: string,
  fileId: string,
  opts: TelegramThreadedSendOpts,
): Promise<TelegramSendResult> {
  if (!fileId?.trim()) {
    throw new Error("Telegram sticker file_id is required");
  }

  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    sendStickerTelegramWithContext(to, fileId, opts, context),
  );
}

async function sendStickerTelegramWithContext(
  to: string,
  fileId: string,
  opts: TelegramThreadedSendOpts,
  context: TelegramApiContext,
): Promise<TelegramSendResult> {
  const { api } = context;
  const prepared = await prepareTelegramOutbound({
    to,
    context,
    opts,
    thread: {
      messageThreadId: opts.messageThreadId,
      replyToMessageId: opts.replyToMessageId,
    },
    request: { kind: "nonIdempotent", useApiErrorLogging: false },
  });
  const stickerParams =
    Object.keys(prepared.threadParams).length > 0 ? prepared.threadParams : undefined;

  const result = await prepared.request(
    () => api.sendSticker(prepared.chatId, fileId.trim(), stickerParams),
    "sticker",
  );
  return finalizeTelegramOutbound({
    context,
    prepared,
    result,
    resultContext: "sticker send",
  });
}

type TelegramPollOpts = TelegramThreadedSendOpts &
  Pick<TelegramSendOpts, "silent"> & {
    /** Whether votes are anonymous. Defaults to true (Telegram default). */
    isAnonymous?: boolean;
  };

/**
 * Send a poll to a Telegram chat.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param poll - Poll input with question, options, maxSelections, and optional durationHours
 * @param opts - Optional configuration
 */
export async function sendPollTelegram(
  to: string,
  poll: PollInput,
  opts: TelegramPollOpts,
): Promise<{ messageId: string; chatId: string; pollId?: string }> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(context, sendPollTelegramWithContext(to, poll, opts, context));
}

async function sendPollTelegramWithContext(
  to: string,
  poll: PollInput,
  opts: TelegramPollOpts,
  context: TelegramApiContext,
): Promise<{ messageId: string; chatId: string; pollId?: string }> {
  const { api } = context;
  const prepared = await prepareTelegramOutbound({
    to,
    context,
    opts,
    thread: {
      messageThreadId: opts.messageThreadId,
      replyToMessageId: opts.replyToMessageId,
    },
    request: { kind: "nonIdempotent" },
  });

  const normalizedPoll = normalizePollInput(poll, { maxOptions: 12 });

  const durationSeconds = normalizedPoll.durationSeconds;
  if (durationSeconds === undefined && normalizedPoll.durationHours !== undefined) {
    throw new Error(
      "Telegram poll durationHours is not supported. Use durationSeconds (5-600) instead.",
    );
  }
  if (durationSeconds !== undefined && (durationSeconds < 5 || durationSeconds > 600)) {
    throw new Error("Telegram poll durationSeconds must be between 5 and 600");
  }

  const pollParams: TelegramSendPollParams = {
    allows_multiple_answers: normalizedPoll.maxSelections > 1,
    is_anonymous: opts.isAnonymous ?? true,
    ...(durationSeconds !== undefined ? { open_period: durationSeconds } : {}),
    ...(Object.keys(prepared.threadParams).length > 0 ? prepared.threadParams : {}),
    ...(opts.silent === true ? { disable_notification: true } : {}),
  };

  const result = await prepared.request(
    () =>
      api.sendPoll(prepared.chatId, normalizedPoll.question, normalizedPoll.options, pollParams),
    "poll",
  );
  const pollId = result?.poll?.id;
  return {
    ...(await finalizeTelegramOutbound({
      context,
      prepared,
      result,
      resultContext: "poll send",
    })),
    pollId,
  };
}

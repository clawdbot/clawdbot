import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import {
  buildTelegramThreadReplyParams,
  resolveTelegramSendThreadSpec,
} from "./reply-parameters.js";
import {
  createRequestWithChatNotFound,
  createTelegramNonIdempotentRequestWithDiag,
  resolveAndPersistChatId,
  resolveTelegramApiContext,
  resolveTelegramMessageIdOrThrow,
  withTelegramApiContextLease,
  type TelegramApiContext,
  type TelegramApiOverride,
} from "./send-context.js";
import type { TelegramSendResult } from "./send-message-types.js";
import { normalizePollInput, type OpenClawConfig, type PollInput } from "./send.runtime.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { parseTelegramTarget } from "./targets.js";

type TelegramSendPollParams = Parameters<TelegramApiContext["api"]["sendPoll"]>[3];

type TelegramStickerOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
};

/**
 * Send a sticker to a Telegram chat by file_id.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param fileId - Telegram file_id of the sticker to send
 * @param opts - Optional configuration
 */
export async function sendStickerTelegram(
  to: string,
  fileId: string,
  opts: TelegramStickerOpts,
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
  opts: TelegramStickerOpts,
  context: TelegramApiContext,
): Promise<TelegramSendResult> {
  const { cfg, account, api } = context;
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
  const threadParams = buildTelegramThreadReplyParams({
    thread: threadSpec,
    replyToMessageId: opts.replyToMessageId,
  });
  const hasThreadParams = Object.keys(threadParams).length > 0;

  const requestWithDiag = createTelegramNonIdempotentRequestWithDiag({
    cfg,
    account,
    retry: opts.retry,
    verbose: opts.verbose,
    useApiErrorLogging: false,
  });
  const requestWithChatNotFound = createRequestWithChatNotFound({
    requestWithDiag,
    chatId,
    input: to,
  });

  const stickerParams = hasThreadParams ? threadParams : undefined;

  const result = await requestWithChatNotFound(
    () => api.sendSticker(chatId, fileId.trim(), stickerParams),
    "sticker",
  );

  const messageId = resolveTelegramMessageIdOrThrow(result, "sticker send");
  const resolvedChatId = String(result?.chat?.id ?? chatId);
  recordSentMessage(chatId, messageId, opts.cfg);
  await recordOutboundMessageForPromptContext({
    cfg,
    account,
    chatId,
    message: result,
    messageId,
    ...(threadSpec?.id !== undefined ? { messageThreadId: threadSpec.id } : {}),
    ...(threadSpec ? { successfulSendThread: threadSpec } : {}),
  });
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { messageId: String(messageId), chatId: resolvedChatId };
}

type TelegramPollOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
  /** Message ID to reply to (for threading) */
  replyToMessageId?: number;
  /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
  /** Send message silently (no notification). Defaults to false. */
  silent?: boolean;
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
  const { cfg, account, api } = context;
  const target = parseTelegramTarget(to);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: to,
    verbose: opts.verbose,
    gatewayClientScopes: opts.gatewayClientScopes,
  });

  // Normalize the poll input (validates question, options, maxSelections)
  const normalizedPoll = normalizePollInput(poll, { maxOptions: 12 });
  const threadSpec = resolveTelegramSendThreadSpec({
    targetMessageThreadId: target.messageThreadId,
    messageThreadId: opts.messageThreadId,
    chatType: target.chatType,
  });
  const threadParams = buildTelegramThreadReplyParams({
    thread: threadSpec,
    replyToMessageId: opts.replyToMessageId,
  });

  // Build poll options as simple strings (Grammy accepts string[] or InputPollOption[])
  const pollOptions = normalizedPoll.options;

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

  const durationSeconds = normalizedPoll.durationSeconds;
  if (durationSeconds === undefined && normalizedPoll.durationHours !== undefined) {
    throw new Error(
      "Telegram poll durationHours is not supported. Use durationSeconds (5-600) instead.",
    );
  }
  if (durationSeconds !== undefined && (durationSeconds < 5 || durationSeconds > 600)) {
    throw new Error("Telegram poll durationSeconds must be between 5 and 600");
  }

  // Build poll parameters following Grammy's api.sendPoll signature
  // sendPoll(chat_id, question, options, other?, signal?)
  const pollParams: TelegramSendPollParams = {
    allows_multiple_answers: normalizedPoll.maxSelections > 1,
    is_anonymous: opts.isAnonymous ?? true,
    ...(durationSeconds !== undefined ? { open_period: durationSeconds } : {}),
    ...(Object.keys(threadParams).length > 0 ? threadParams : {}),
    ...(opts.silent === true ? { disable_notification: true } : {}),
  };

  const result = await requestWithChatNotFound(
    () => api.sendPoll(chatId, normalizedPoll.question, pollOptions, pollParams),
    "poll",
  );

  const messageId = resolveTelegramMessageIdOrThrow(result, "poll send");
  const resolvedChatId = String(result?.chat?.id ?? chatId);
  const pollId = result?.poll?.id;
  recordSentMessage(chatId, messageId, opts.cfg);
  await recordOutboundMessageForPromptContext({
    cfg,
    account,
    chatId,
    message: result,
    messageId,
    ...(threadSpec?.id !== undefined ? { messageThreadId: threadSpec.id } : {}),
    ...(threadSpec ? { successfulSendThread: threadSpec } : {}),
  });

  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });

  return { messageId: String(messageId), chatId: resolvedChatId, pollId };
}

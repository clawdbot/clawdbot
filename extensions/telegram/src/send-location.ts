import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  formatLocationText,
  normalizeOutboundLocation,
  type OutboundLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import {
  buildTelegramThreadReplyParams,
  resolveTelegramSendThreadSpec,
} from "./reply-parameters.js";
import {
  createRequestWithChatNotFound,
  createTelegramNonIdempotentRequestWithDiag,
  logTelegramOutboundSendOk,
  resolveAndPersistChatId,
  resolveTelegramApiContext,
  resolveTelegramMessageIdOrThrow,
  toAcceptedThreadScopedParams,
  withTelegramApiContextLease,
  withTelegramNativeQuoteFallback,
  type TelegramApiContext,
} from "./send-context.js";
import type { TelegramLocationSendOpts, TelegramSendResult } from "./send-message-types.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { parseTelegramTarget } from "./targets.js";
import { resolveTelegramBotUserIdFromToken } from "./token.js";

type TelegramSendLocationParams = Parameters<TelegramApiContext["api"]["sendLocation"]>[3];
type TelegramSendVenueParams = Parameters<TelegramApiContext["api"]["sendVenue"]>[5];

/** Send a standalone location pin or named venue through Telegram's native payload. */
export async function sendLocationTelegram(
  to: string,
  input: OutboundLocation,
  opts: TelegramLocationSendOpts,
): Promise<TelegramSendResult> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    sendLocationTelegramWithContext(to, input, opts, context),
  );
}

async function sendLocationTelegramWithContext(
  to: string,
  input: OutboundLocation,
  opts: TelegramLocationSendOpts,
  context: TelegramApiContext,
): Promise<TelegramSendResult> {
  const location = normalizeOutboundLocation(input);
  if (!location) {
    throw new Error("Telegram location is required.");
  }
  const hasName = Boolean(location.name);
  const hasAddress = Boolean(location.address);
  if (hasName !== hasAddress) {
    throw new Error("Telegram venues require both location.name and location.address.");
  }

  const { cfg, account, api } = context;
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
  const threadParams = buildTelegramThreadReplyParams({
    thread: threadSpec,
    replyToMessageId: opts.replyToMessageId,
    replyQuoteText: opts.quoteText,
    useReplyIdAsQuoteSource: true,
  });
  const replyMarkup = buildInlineKeyboard(opts.buttons);
  const commonParams = {
    ...threadParams,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(opts.silent === true ? { disable_notification: true } : {}),
  };
  const requestWithChatNotFound = createRequestWithChatNotFound({
    requestWithDiag: createTelegramNonIdempotentRequestWithDiag({
      cfg,
      account,
      retry: opts.retry,
      verbose: opts.verbose,
    }),
    chatId,
    input: to,
  });
  const label = hasName ? "venue" : "location";
  const delivery = await withTelegramNativeQuoteFallback({
    label,
    requestParams: commonParams,
    request: (effectiveParams, retryLabel) =>
      requestWithChatNotFound(
        () =>
          hasName
            ? api.sendVenue(
                chatId,
                location.latitude,
                location.longitude,
                location.name ?? "",
                location.address ?? "",
                effectiveParams as TelegramSendVenueParams,
              )
            : api.sendLocation(chatId, location.latitude, location.longitude, {
                ...effectiveParams,
                ...(location.accuracy !== undefined
                  ? { horizontal_accuracy: location.accuracy }
                  : {}),
              } as TelegramSendLocationParams),
        retryLabel,
      ),
  });
  const result = delivery.result;
  const acceptedParams = toAcceptedThreadScopedParams(delivery.acceptedParams);
  const messageId = resolveTelegramMessageIdOrThrow(result, `${label} send`);
  const resolvedChatId = String(result?.chat?.id ?? chatId);
  recordSentMessage(chatId, messageId, cfg);
  await opts.onDeliveryResult?.({ messageId: String(messageId), chatId: resolvedChatId });
  const projectionPlan = opts.promptContextProjectionPlan;
  const projection = projectionPlan?.cursor.take(projectionPlan.finalPart);
  const recorded = await recordOutboundMessageForPromptContext({
    cfg,
    account,
    ...(botUserId !== undefined ? { botUserId } : {}),
    chatId,
    message: result,
    messageId,
    text: formatLocationText(location),
    ...(threadSpec?.id !== undefined ? { messageThreadId: threadSpec.id } : {}),
    ...(threadSpec ? { successfulSendThread: threadSpec } : {}),
    ...(acceptedParams?.message_thread_id !== undefined
      ? { messageThreadId: acceptedParams.message_thread_id }
      : {}),
    promptContextProjection: projection,
  });
  if (projection && !recorded) {
    projectionPlan?.cursor.invalidate();
  }
  logTelegramOutboundSendOk({
    accountId: account.accountId,
    chatId: resolvedChatId,
    messageId: String(messageId),
    operation: hasName ? "sendVenue" : "sendLocation",
    deliveryKind: label,
    messageThreadId: acceptedParams?.message_thread_id,
    replyToMessageId: opts.replyToMessageId,
    silent: opts.silent,
  });
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });
  return { messageId: String(messageId), chatId: resolvedChatId };
}

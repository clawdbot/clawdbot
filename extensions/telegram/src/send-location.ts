import {
  formatLocationText,
  normalizeOutboundLocation,
  type OutboundLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import {
  logTelegramOutboundSendOk,
  resolveTelegramApiContext,
  toAcceptedThreadScopedParams,
  withTelegramApiContextLease,
  withTelegramNativeQuoteFallback,
  type TelegramApiContext,
} from "./send-context.js";
import type { TelegramLocationSendOpts, TelegramSendResult } from "./send-message-types.js";
import { finalizeTelegramOutbound, prepareTelegramOutbound } from "./send-outbound.js";
import { resolveTelegramBotUserIdFromToken } from "./token-fingerprint.js";

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

  const { account, api } = context;
  const botUserId = resolveTelegramBotUserIdFromToken(opts.token || account.token);
  const prepared = await prepareTelegramOutbound({
    to,
    context,
    opts,
    thread: {
      messageThreadId: opts.messageThreadId,
      replyToMessageId: opts.replyToMessageId,
      replyQuoteText: opts.quoteText,
      useReplyIdAsQuoteSource: true,
    },
    request: { kind: "nonIdempotent" },
  });
  const replyMarkup = buildInlineKeyboard(opts.buttons);
  const commonParams = {
    ...prepared.threadParams,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(opts.silent === true ? { disable_notification: true } : {}),
  };
  const label = hasName ? "venue" : "location";
  const delivery = await withTelegramNativeQuoteFallback({
    label,
    requestParams: commonParams,
    request: async (effectiveParams, retryLabel) => {
      await opts.onPlatformSendDispatch?.();
      return await prepared.request(
        () =>
          hasName
            ? api.sendVenue(
                prepared.chatId,
                location.latitude,
                location.longitude,
                location.name ?? "",
                location.address ?? "",
                effectiveParams as TelegramSendVenueParams,
              )
            : api.sendLocation(prepared.chatId, location.latitude, location.longitude, {
                ...effectiveParams,
                ...(location.accuracy !== undefined
                  ? { horizontal_accuracy: location.accuracy }
                  : {}),
              } as TelegramSendLocationParams),
        retryLabel,
      );
    },
  });
  const result = delivery.result;
  const acceptedParams = toAcceptedThreadScopedParams(delivery.acceptedParams);
  return finalizeTelegramOutbound({
    context,
    prepared,
    result,
    resultContext: `${label} send`,
    ...(botUserId !== undefined ? { botUserId } : {}),
    text: formatLocationText(location),
    ...(acceptedParams?.message_thread_id !== undefined
      ? { messageThreadId: acceptedParams.message_thread_id }
      : {}),
    promptContextProjectionPlan: opts.promptContextProjectionPlan,
    onDeliveryResult: opts.onDeliveryResult,
    beforeActivity: ({ messageId, chatId }) =>
      logTelegramOutboundSendOk({
        accountId: account.accountId,
        chatId,
        messageId,
        operation: hasName ? "sendVenue" : "sendLocation",
        deliveryKind: label,
        messageThreadId: acceptedParams?.message_thread_id,
        replyToMessageId: opts.replyToMessageId,
        silent: opts.silent,
      }),
  });
}

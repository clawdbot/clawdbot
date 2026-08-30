import type { InlineKeyboardMarkup, Message } from "grammy/types";
import { createChannelApiRetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  createTelegramChunkDeliveryTracker,
  mergeTelegramPartialDeliveryError,
} from "./chunk-delivery.js";
import { rethrowTelegramSendError, shouldRetryTelegramSendError } from "./network-errors.js";
import {
  sendTelegramCaptionedMediaWithFallback,
  sendTelegramOutboundMediaWithPhotoFallback,
  type TelegramOutboundMediaSender,
} from "./outbound-media.js";
import {
  getTelegramNativeQuoteReplyMessageId,
  isTelegramQuoteParamError,
} from "./reply-parameters.js";
import { TELEGRAM_OUTBOUND_RETRY_AFTER_CAP_MS } from "./retry-after.js";
import {
  removeTelegramRichNativeQuoteParam,
  toTelegramRichMessageContextParams,
} from "./rich-message.js";
import { isTelegramEmptyContentError, isTelegramHtmlParseError } from "./rich-plain-fallback.js";
import {
  resolveTelegramMessageIdOrThrow,
  withTelegramNativeQuoteFallback,
  type TelegramApi,
} from "./send-context.js";
import {
  isTelegramPhotoLimitError,
  isTelegramVoiceMessagesForbiddenError,
} from "./send-error-predicates.js";
import {
  sendTelegramTextPageParts,
  type TelegramTextDeliveryPage,
} from "./telegram-text-delivery.js";

type PreparedRequest = <T>(
  send: () => Promise<T>,
  label: string,
  options?: {
    shouldLog?: (error: unknown) => boolean;
  },
) => Promise<T>;

export function createTelegramReplyRequest(runtime: RuntimeEnv): PreparedRequest {
  const retry = createChannelApiRetryRunner({
    shouldRetry: shouldRetryTelegramSendError,
    strictShouldRetry: true,
    retryAfterMaxDelayMs: TELEGRAM_OUTBOUND_RETRY_AFTER_CAP_MS,
  });
  return (send, operation, options) =>
    withTelegramApiErrorLogging({
      operation,
      runtime,
      shouldLog: options?.shouldLog,
      fn: () => retry(send, operation),
    }).catch(rethrowTelegramSendError);
}

export type TelegramPreparedSendPart = {
  result: Message;
  acceptedParams: Record<string, unknown>;
  plainText: string;
  hasInlineKeyboard: boolean;
};

type TextFallback = { index: number; count: number };
type AcceptedPart = TelegramPreparedSendPart & { messageId: number };
type ObservePart = (part: AcceptedPart) => Promise<void>;
type PartialDeliveryResult = Parameters<typeof mergeTelegramPartialDeliveryError>[1];
type Tracking = Omit<
  Parameters<typeof createTelegramChunkDeliveryTracker>[0],
  "partialDeliveryResult" | "isSilentSkip"
> & {
  partialDeliveryResult?: Parameters<
    typeof createTelegramChunkDeliveryTracker
  >[0]["partialDeliveryResult"];
};

export function createTelegramPreparedSender(config: {
  api: TelegramApi;
  chatId: string;
  request: PreparedRequest;
  warn: (message: string) => void;
  beforeTextPage?: () => Promise<void>;
  beforeMedia?: () => Promise<void>;
}) {
  const parts: AcceptedPart[] = [];
  const fail = (error: unknown, start = 0, details?: PartialDeliveryResult): never => {
    if (parts.length === start) {
      throw error;
    }
    throw mergeTelegramPartialDeliveryError(error, {
      ...details,
      messageIds: parts.slice(start).map((part) => String(part.messageId)),
      visibleReplySent: true,
    });
  };
  const recordAcceptance = (part: TelegramPreparedSendPart) => {
    const accepted = { ...part, messageId: resolveTelegramMessageIdOrThrow(part.result, "send") };
    // One ledger owns provider acceptance. Receipt/cache/projection observers are
    // fallible and cannot retroactively turn an accepted part into a rejection.
    parts.push(accepted);
    return accepted;
  };
  const accept = async (
    part: TelegramPreparedSendPart,
    observe: ObservePart,
    details?: () => PartialDeliveryResult,
  ) => {
    const accepted = recordAcceptance(part);
    try {
      await observe(accepted);
    } catch (error) {
      fail(error, 0, details?.());
    }
  };
  const request = <T>(
    label: string,
    requestParams: Record<string, unknown>,
    send: (effective: Record<string, unknown>) => Promise<T>,
    options?: {
      rich?: boolean;
      shouldLog?: (error: unknown) => boolean;
    },
  ) =>
    withTelegramNativeQuoteFallback({
      label,
      requestParams,
      ...(options?.rich ? { removeNativeQuoteParam: removeTelegramRichNativeQuoteParam } : {}),
      request: (effective, operation) =>
        config.request(() => send(effective), operation, {
          shouldLog: (error) =>
            (options?.shouldLog?.(error) ?? true) &&
            !(getTelegramNativeQuoteReplyMessageId(effective) && isTelegramQuoteParamError(error)),
        }),
    });

  const sendText = async (params: {
    pages: readonly TelegramTextDeliveryPage[];
    context: string;
    preparePage: (
      index: number,
      acceptedPages: number,
    ) => {
      requestParams: (
        fallback?: TextFallback,
      ) => Record<string, unknown> & { reply_markup?: InlineKeyboardMarkup };
      delivered?: () => void;
    };
    observe: ObservePart;
    tracking: Tracking;
    /** Durable text drains definite rejected fallback parts; direct replies stop that page. */
    drainFallback?: boolean;
  }) => {
    const start = parts.length;
    const tracker = createTelegramChunkDeliveryTracker({
      ...params.tracking,
      isSilentSkip: isTelegramEmptyContentError,
      partialDeliveryResult: () => ({
        ...params.tracking.partialDeliveryResult?.(),
        messageIds: parts.slice(start).map((part) => String(part.messageId)),
        visibleReplySent: true,
      }),
    });
    let acceptedPages = 0;
    for (const [index, page] of params.pages.entries()) {
      let prepared: ReturnType<typeof params.preparePage>;
      try {
        await config.beforeTextPage?.();
        prepared = params.preparePage(index, acceptedPages);
      } catch (error) {
        tracker.reject(error);
        continue;
      }
      const sendPlainOrHtml = async (
        text: string,
        html: boolean,
        fallback?: TextFallback,
        label = "sendMessage",
      ) => {
        const requestParams: Record<string, unknown> = {
          ...prepared.requestParams(fallback),
          ...(html ? { parse_mode: "HTML" as const } : {}),
        };
        const send = () =>
          request(
            label,
            requestParams,
            (effective) =>
              Object.keys(effective).length
                ? config.api.sendMessage(config.chatId, text, effective)
                : config.api.sendMessage(config.chatId, text),
            {
              shouldLog: (error) =>
                !isTelegramHtmlParseError(error) && !isTelegramEmptyContentError(error),
            },
          );
        let sent;
        try {
          sent = await send();
        } catch (error) {
          if (!fallback || !params.drainFallback) {
            throw error;
          }
          // Keep the producer alive for a definite rejected plain part. A
          // rejected next() would close its generator and lose the remaining tail.
          tracker.reject(error);
          return undefined;
        }
        return { ...sent, hasInlineKeyboard: Boolean(sent.acceptedParams.reply_markup) };
      };
      const iterator = sendTelegramTextPageParts({
        page,
        context: params.context,
        warn: config.warn,
        sender: {
          sendPlain: (text, fallback, label) => sendPlainOrHtml(text, false, fallback, label),
          sendHtml: (text) => sendPlainOrHtml(text, true),
          sendRich: async (richMessage) => {
            const rawParams = prepared.requestParams();
            const markup = rawParams.reply_markup ? { reply_markup: rawParams.reply_markup } : {};
            const sent = await request(
              "sendRichMessage",
              toTelegramRichMessageContextParams(rawParams),
              (effective) =>
                config.api.raw.sendRichMessage({
                  chat_id: config.chatId,
                  rich_message: richMessage,
                  ...effective,
                  ...markup,
                }),
              { rich: true },
            );
            // Quote fallback rewrites context only. Keep the prepared keyboard
            // on both physical attempts and record the fields actually accepted.
            const acceptedParams = { ...sent.acceptedParams, ...markup };
            return {
              ...sent,
              acceptedParams,
              hasInlineKeyboard: Boolean(acceptedParams.reply_markup),
            };
          },
        },
      });
      try {
        while (true) {
          let next;
          try {
            next = await iterator.next();
          } catch (error) {
            tracker.reject(error);
            break;
          }
          if (next.done) {
            acceptedPages += 1;
            prepared.delivered?.();
            break;
          }
          if (next.value.result) {
            const part = { ...next.value.result, plainText: next.value.page.plainText };
            await tracker.recordAccepted(recordAcceptance(part), params.observe);
          }
        }
      } finally {
        // This producer has no I/O in finalization; return only closes suspended
        // iteration, so an observer failure cannot publish another fallback part.
        await iterator.return(undefined);
      }
    }
    tracker.finish();
    return parts.slice(start);
  };

  const sendMedia = async (params: {
    sender: TelegramOutboundMediaSender<Message>;
    documentSender?: TelegramOutboundMediaSender<Message>;
    requestParams: Record<string, unknown>;
    plainCaption?: string;
  }) => {
    const send = async (sender: TelegramOutboundMediaSender<Message>) => {
      await config.beforeMedia?.();
      return sendTelegramCaptionedMediaWithFallback({
        operation: sender.operation,
        requestParams: params.requestParams,
        plainCaption: params.plainCaption,
        shouldLog: (error) =>
          sender.label === "photo"
            ? !isTelegramPhotoLimitError(error)
            : sender.label !== "voice" || !isTelegramVoiceMessagesForbiddenError(error),
        send: (requestParams, shouldLog) =>
          request(sender.operation, requestParams, sender.send, { shouldLog }),
      });
    };
    const delivery = await sendTelegramOutboundMediaWithPhotoFallback({
      sender: params.sender,
      documentSender: params.documentSender ?? params.sender,
      send,
    });
    return {
      ...delivery.result.result,
      plainText: delivery.result.deliveredCaption ?? "",
      hasInlineKeyboard: Boolean(delivery.result.result.acceptedParams.reply_markup),
      captionRemoved: delivery.result.captionRemoved,
      sender: delivery.sender,
    };
  };
  return { parts, accept, fail, sendText, sendMedia };
}

export type TelegramPreparedSender = ReturnType<typeof createTelegramPreparedSender>;

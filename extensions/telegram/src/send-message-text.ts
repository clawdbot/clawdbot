import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { createTelegramChunkDeliveryTracker } from "./chunk-delivery.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import type { TelegramOutboundPromptContextMessage as TelegramMessageLike } from "./outbound-message-context.js";
import {
  getTelegramRichRawApi,
  removeTelegramRichNativeQuoteParam,
  toTelegramRichMessageContextParams,
  type TelegramRichMessageContextParams,
} from "./rich-message.js";
import { isTelegramEmptyContentError } from "./rich-plain-fallback.js";
import {
  logTelegramOutboundSendOk,
  resolveAcceptedReplyToMessageId,
  resolveTelegramMessageIdOrThrow,
  sendLogger,
  toAcceptedThreadScopedParams,
  withTelegramNativeQuoteFallback,
  type TelegramApi,
  type TelegramThreadScopedParams,
} from "./send-context.js";
import type {
  TelegramSendMessageParams,
  TelegramSendOpts,
  TelegramSendResult,
} from "./send-message-types.js";
import type { OpenClawConfig } from "./send.runtime.js";
import { recordSentMessage } from "./sent-message-cache.js";
import {
  deliverTelegramTextPage,
  planTelegramTextDeliveryPages,
} from "./telegram-text-delivery.js";
import { resolveTelegramTextChunkLimit } from "./text-chunk-limit.js";

type SendTextOptions = {
  replyToAlreadyUsed?: boolean;
  beforeFirstAccepted?: () => Promise<void>;
};

function buildTelegramTextSendReceipt(params: {
  results: readonly TelegramSendResult[];
  replyToMessageId?: number;
}) {
  if (params.results.length === 0) {
    return undefined;
  }
  if (params.results.length === 1) {
    return params.results[0]?.receipt;
  }
  const receipt = createMessageReceiptFromOutboundResults({
    results: params.results,
    kind: "text",
    ...(typeof params.replyToMessageId === "number"
      ? { replyToId: String(params.replyToMessageId) }
      : {}),
  });
  receipt.parts = receipt.parts.map((part, index) => ({ ...part, index }));
  return receipt;
}

export function createTelegramTextSender(config: {
  cfg: OpenClawConfig;
  ownerAgentId: string;
  account: ResolvedTelegramAccount;
  api: TelegramApi;
  chatId: string;
  opts: TelegramSendOpts;
  replyMarkup: ReturnType<typeof buildInlineKeyboard>;
  reportDelivery: (
    messageId: string | number,
    deliveredChatId: string | number,
    message: TelegramMessageLike,
    meta?: TelegramSendResult["meta"],
    kind?: "text" | "media",
    onPrepared?: (delivery: TelegramSendResult) => void,
  ) => Promise<TelegramSendResult>;
  recordDeliveredPromptContext: (
    params: Omit<
      Parameters<typeof recordOutboundMessageForPromptContext>[0],
      "cfg" | "account" | "botUserId" | "chatId" | "promptContextProjection"
    >,
    finalPart: boolean,
  ) => Promise<void>;
  singleUseReplyTo: boolean;
  buildThreadParams: (includeReplyTo: boolean) => Record<string, unknown>;
  requestWithChatNotFound: <T>(fn: () => Promise<T>, label: string) => Promise<T>;
  textMode: "markdown" | "html";
  tableMode: MarkdownTableMode;
  renderHtmlText: (value: string) => string;
  linkPreviewOptions: { is_disabled: boolean } | undefined;
  useRichMessages: boolean;
}) {
  const {
    cfg,
    ownerAgentId,
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
  } = config;

  const shouldIncludeReply = (index: number, count: number, alreadyUsed: boolean) =>
    !alreadyUsed && (!singleUseReplyTo || (count === 1 && index === 0));
  const buildTextParams = (
    index: number,
    count: number,
    finalPart: boolean,
    alreadyUsed: boolean,
  ) => {
    const thread = buildThreadParams(shouldIncludeReply(index, count, alreadyUsed));
    return Object.keys(thread).length || (finalPart && replyMarkup)
      ? { ...thread, ...(finalPart && replyMarkup ? { reply_markup: replyMarkup } : {}) }
      : undefined;
  };
  const buildRichParams = (
    index: number,
    count: number,
    finalPart: boolean,
    alreadyUsed: boolean,
  ) => {
    const thread = toTelegramRichMessageContextParams(
      buildThreadParams(shouldIncludeReply(index, count, alreadyUsed)),
    );
    return Object.keys(thread).length || (finalPart && replyMarkup)
      ? { ...thread, ...(finalPart && replyMarkup ? { reply_markup: replyMarkup } : {}) }
      : undefined;
  };

  const createTextDelivery = (context: string, beforeFirstAccepted?: () => Promise<void>) => {
    type PendingChunk = {
      result: TelegramMessageLike;
      messageId: number;
      acceptedParams?: TelegramThreadScopedParams | TelegramRichMessageContextParams;
      plainText: string;
      reportChatId: string | number;
      hasInlineKeyboard: boolean;
    };

    let lastMessageId = "";
    let lastChatId = chatId;
    let lastAcceptedParams:
      | TelegramThreadScopedParams
      | TelegramRichMessageContextParams
      | undefined;
    let acceptedReplyToMessageId: number | undefined;
    const messageIds: string[] = [];
    const deliveryResults: TelegramSendResult[] = [];
    let sentChunkCount = 0;
    let pendingChunk: PendingChunk | undefined;
    let finalMeta: TelegramSendResult["meta"] | undefined;

    const flushChunk = async (chunk: PendingChunk, finalPart: boolean) => {
      let keyboardError: unknown;
      if (finalPart && replyMarkup && !chunk.hasInlineKeyboard) {
        try {
          await api.editMessageReplyMarkup(chunk.reportChatId, chunk.messageId, {
            reply_markup: replyMarkup,
          });
          finalMeta = {
            telegramDeliveredText: chunk.plainText,
            telegramHasInlineKeyboard: true,
          };
        } catch (error) {
          keyboardError = error;
        }
      }
      await recordDeliveredPromptContext(
        {
          message: chunk.result,
          messageId: chunk.messageId,
          text: chunk.plainText,
          ...(chunk.acceptedParams?.message_thread_id !== undefined
            ? { messageThreadId: chunk.acceptedParams.message_thread_id }
            : {}),
        },
        finalPart,
      );
      if (keyboardError !== undefined) {
        // finish() routes this through tracker.fail(), which preserves the
        // accepted message IDs in a partial-delivery error.
        if (keyboardError instanceof Error) {
          throw keyboardError;
        }
        throw new Error(formatErrorMessage(keyboardError));
      }
    };

    const flushPending = async (finalPart: boolean) => {
      const chunk = pendingChunk;
      pendingChunk = undefined;
      if (chunk) {
        await flushChunk(chunk, finalPart);
      }
    };

    const record = async (params: {
      result: TelegramMessageLike;
      acceptedParams?: TelegramThreadScopedParams | TelegramRichMessageContextParams;
      plainText: string;
      hasInlineKeyboard: boolean;
    }) => {
      const messageId = resolveTelegramMessageIdOrThrow(params.result, context);
      // Preserve Telegram's accepted identity before fallible observers run so
      // partial errors retain every provider-visible delivery fact.
      lastMessageId = String(messageId);
      lastChatId = String(params.result.chat?.id ?? chatId);
      lastAcceptedParams = params.acceptedParams;
      acceptedReplyToMessageId ??= resolveAcceptedReplyToMessageId(params.acceptedParams);
      messageIds.push(lastMessageId);
      if (sentChunkCount === 0) {
        await beforeFirstAccepted?.();
      }
      sentChunkCount += 1;
      recordSentMessage(chatId, messageId, cfg, {
        accountId: account.accountId,
        agentId: ownerAgentId,
      });
      await reportDelivery(
        messageId,
        params.result?.chat?.id ?? chatId,
        params.result,
        {
          telegramDeliveredText: params.plainText,
          telegramHasInlineKeyboard: params.hasInlineKeyboard,
        },
        "text",
        (delivery) => deliveryResults.push(delivery),
      );
      const previousChunk = pendingChunk;
      pendingChunk = {
        result: params.result,
        messageId,
        acceptedParams: params.acceptedParams,
        plainText: params.plainText,
        reportChatId: params.result?.chat?.id ?? chatId,
        hasInlineKeyboard: params.hasInlineKeyboard,
      };
      if (previousChunk) {
        await flushChunk(previousChunk, false);
      }
    };

    const finish = async (operation: string): Promise<TelegramSendResult> => {
      await flushPending(true);
      if (lastMessageId) {
        logTelegramOutboundSendOk({
          accountId: account.accountId,
          chatId: lastChatId,
          messageId: lastMessageId,
          operation,
          deliveryKind: "text",
          messageThreadId: lastAcceptedParams?.message_thread_id,
          replyToMessageId: opts.replyToMessageId,
          silent: opts.silent,
          chunkCount: messageIds.length,
        });
      }
      const receipt = buildTelegramTextSendReceipt({
        results: deliveryResults,
        replyToMessageId: acceptedReplyToMessageId,
      });
      return {
        messageId: lastMessageId,
        chatId: lastChatId,
        ...(receipt ? { receipt } : {}),
        ...(finalMeta ? { meta: finalMeta } : {}),
      };
    };

    const partialDeliveryResult = () => {
      const receipt = buildTelegramTextSendReceipt({
        results: deliveryResults,
        replyToMessageId: acceptedReplyToMessageId,
      });
      return {
        messageIds: [...messageIds],
        ...(receipt ? { receipt } : {}),
        visibleReplySent: true as const,
      };
    };

    const fail = async (
      error: unknown,
      throwAfterAccepted: (error: unknown) => never,
    ): Promise<never> => {
      try {
        await flushPending(false);
      } catch (flushError) {
        sendLogger.warn(
          `telegram ${context} delivery bookkeeping cleanup failed: ${formatErrorMessage(flushError)}`,
        );
      }
      return throwAfterAccepted(error);
    };

    return { record, finish, fail, partialDeliveryResult };
  };

  const requestText = async (
    text: string,
    params: TelegramSendMessageParams | undefined,
    html: boolean,
    label = "message",
  ) => {
    const requestParams: TelegramSendMessageParams = {
      ...params,
      ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
      ...(opts.silent === true ? { disable_notification: true } : {}),
      ...(html ? { parse_mode: "HTML" as const } : {}),
    };
    const sent = await withTelegramNativeQuoteFallback({
      label,
      requestParams,
      request: async (effectiveParams, requestLabel) => {
        await opts.onPlatformSendDispatch?.();
        return await requestWithChatNotFound(
          () =>
            Object.keys(effectiveParams).length
              ? api.sendMessage(chatId, text, effectiveParams)
              : api.sendMessage(chatId, text),
          requestLabel,
        );
      },
    });
    return {
      result: sent.result,
      acceptedParams: toAcceptedThreadScopedParams(sent.acceptedParams),
    };
  };

  const sendChunkedText = async (
    rawText: string,
    context: string,
    options: SendTextOptions = {},
  ): Promise<TelegramSendResult> => {
    const delivery = createTextDelivery(context, options.beforeFirstAccepted);
    const tracker = createTelegramChunkDeliveryTracker({
      invalidate: () => opts.promptContextProjectionPlan?.cursor.invalidate(),
      onRejected: (error) =>
        logVerbose(
          `telegram ${context} text chunk rejected; continuing: ${formatErrorMessage(error)}`,
        ),
      isSilentSkip: isTelegramEmptyContentError,
      onSilentSkip: (error) =>
        logVerbose(
          `telegram ${context} text chunk rendered empty; skipping: ${formatErrorMessage(error)}`,
        ),
      partialDeliveryResult: delivery.partialDeliveryResult,
    });
    const alreadyUsed = options.replyToAlreadyUsed === true;
    const maxChars = useRichMessages
      ? resolveTelegramTextChunkLimit({ cfg, accountId: account.accountId })
      : 4000;
    const pages = planTelegramTextDeliveryPages({
      text: textMode === "html" ? renderHtmlText(rawText) : rawText,
      maxChars,
      tableMode,
      richMessages: useRichMessages,
      skipEntityDetection: account.config.linkPreview === false,
      ...(textMode === "html" ? { textMode: "html" as const } : {}),
      warn: (message) => sendLogger.warn(message),
    });
    try {
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index]!;
        const lastPage = index === pages.length - 1;
        const recordAccepted = (
          sent: {
            result: TelegramMessageLike;
            acceptedParams?: TelegramThreadScopedParams | TelegramRichMessageContextParams;
          },
          plainText: string,
          finalPart: boolean,
        ) =>
          tracker.recordAccepted(sent, ({ result, acceptedParams }) =>
            delivery.record({
              result,
              acceptedParams,
              plainText,
              hasInlineKeyboard: finalPart && Boolean(replyMarkup),
            }),
          );
        try {
          await deliverTelegramTextPage({
            page,
            context,
            warn: (message) => sendLogger.warn(message),
            sender: {
              sendPlain: async (plainText, fallback, label) => {
                const fallbackCount = fallback?.count ?? pages.length;
                const fallbackIndex = fallback
                  ? pages.length === 1
                    ? fallback.index
                    : index
                  : index;
                const finalPart = lastPage && (!fallback || fallback.index === fallback.count - 1);
                const requestPlain = () =>
                  requestText(
                    plainText,
                    buildTextParams(
                      fallbackIndex,
                      Math.max(pages.length, fallbackCount),
                      finalPart,
                      alreadyUsed,
                    ),
                    false,
                    label,
                  );
                if (fallback) {
                  let sent: Awaited<ReturnType<typeof requestPlain>> | undefined;
                  await tracker.attempt(
                    async () => (sent = await requestPlain()),
                    ({ result, acceptedParams }) =>
                      delivery.record({
                        result,
                        acceptedParams,
                        plainText,
                        hasInlineKeyboard: finalPart && Boolean(replyMarkup),
                      }),
                  );
                  return sent;
                }
                const sent = await requestPlain();
                await recordAccepted(sent, plainText, finalPart);
                return sent;
              },
              sendHtml: async (htmlText) => {
                const sent = await requestText(
                  htmlText,
                  buildTextParams(index, pages.length, lastPage, alreadyUsed),
                  true,
                );
                await recordAccepted(sent, page.plainText, lastPage);
                return sent;
              },
              sendRich: async (richMessage) => {
                const requestParams = buildRichParams(index, pages.length, lastPage, alreadyUsed);
                const sent = await withTelegramNativeQuoteFallback<TelegramMessageLike>({
                  label: "richMessage",
                  requestParams: requestParams ?? {},
                  removeNativeQuoteParam: removeTelegramRichNativeQuoteParam,
                  request: async (effectiveParams, label) => {
                    await opts.onPlatformSendDispatch?.();
                    return await requestWithChatNotFound(
                      () =>
                        getTelegramRichRawApi(api).sendRichMessage({
                          chat_id: chatId,
                          rich_message: richMessage,
                          ...effectiveParams,
                          ...(opts.silent === true ? { disable_notification: true } : {}),
                        }),
                      label,
                    );
                  },
                });
                const accepted = {
                  result: sent.result,
                  acceptedParams: toTelegramRichMessageContextParams(sent.acceptedParams),
                };
                await recordAccepted(accepted, page.plainText, lastPage);
                return accepted;
              },
            },
          });
        } catch (error) {
          tracker.reject(error);
        }
      }
      tracker.finish();
      return await delivery.finish(useRichMessages ? "sendRichMessage" : "sendMessage");
    } catch (error) {
      // Terminal/ambiguous failures escape tracker.reject before its invalidate
      // branch; the projection cursor must not claim clean custody for pages
      // that never landed (main's pre-centralization outer-catch contract).
      if (!isTelegramEmptyContentError(error)) {
        opts.promptContextProjectionPlan?.cursor.invalidate();
      }
      return await delivery.fail(error, tracker.fail);
    }
  };

  return { sendChunkedText };
}

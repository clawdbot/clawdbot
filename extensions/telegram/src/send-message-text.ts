import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { createTelegramChunkDeliveryTracker } from "./chunk-delivery.js";
import {
  markdownToTelegramChunks,
  splitTelegramHtmlChunks,
  telegramHtmlToPlainTextFallback,
} from "./format.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import type { TelegramOutboundPromptContextMessage as TelegramMessageLike } from "./outbound-message-context.js";
import {
  getTelegramRichRawApi,
  isEmptyTelegramRichMessage,
  removeTelegramRichNativeQuoteParam,
  splitTelegramRichMessageTextChunks,
  TELEGRAM_RICH_TEXT_LIMIT,
  toTelegramRichMessageContextParams,
  type TelegramRichMessageContextParams,
  type TelegramRichTextChunk,
} from "./rich-message.js";
import {
  buildTelegramPlainFallbackPlan,
  splitTelegramPlainTextChunks,
  warnTelegramRichBlocksDegradations,
} from "./rich-plain-fallback.js";
import {
  logTelegramOutboundSendOk,
  resolveAcceptedReplyToMessageId,
  resolveTelegramMessageIdOrThrow,
  sendLogger,
  toAcceptedThreadScopedParams,
  withTelegramHtmlParseFallback,
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

function buildTelegramTextSendReceipt(params: {
  messageIds: readonly string[];
  chatId: string;
  messageThreadId?: number;
  replyToMessageId?: number;
}) {
  if (params.messageIds.length <= 1) {
    return undefined;
  }
  return createMessageReceiptFromOutboundResults({
    results: params.messageIds.map((messageId) => ({
      messageId,
      chatId: params.chatId,
    })),
    kind: "text",
    ...(typeof params.messageThreadId === "number"
      ? { threadId: String(params.messageThreadId) }
      : {}),
    ...(typeof params.replyToMessageId === "number"
      ? { replyToId: String(params.replyToMessageId) }
      : {}),
  });
}

export function createTelegramTextSender(config: {
  cfg: OpenClawConfig;
  account: ResolvedTelegramAccount;
  api: TelegramApi;
  chatId: string;
  opts: TelegramSendOpts;
  replyMarkup: ReturnType<typeof buildInlineKeyboard>;
  reportDelivery: (
    messageId: string | number,
    deliveredChatId: string | number,
    meta?: TelegramSendResult["meta"],
  ) => Promise<void>;
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

  type TelegramTextChunk = {
    plainText: string;
    htmlText?: string;
  };

  const sendTelegramTextChunk = async (
    chunk: TelegramTextChunk,
    params?: TelegramSendMessageParams,
  ) => {
    const baseParams = params ? { ...params } : {};
    if (linkPreviewOptions) {
      baseParams.link_preview_options = linkPreviewOptions;
    }
    const plainParams: TelegramSendMessageParams = {
      ...baseParams,
      ...(opts.silent === true ? { disable_notification: true } : {}),
    };
    const requestSendMessage = (
      label: string,
      messageText: string,
      requestParams: Record<string, unknown>,
    ) =>
      withTelegramNativeQuoteFallback({
        label,
        requestParams,
        request: (effectiveParams, retryLabel) =>
          requestWithChatNotFound(
            () =>
              Object.keys(effectiveParams).length > 0
                ? api.sendMessage(chatId, messageText, effectiveParams)
                : api.sendMessage(chatId, messageText),
            retryLabel,
          ),
      });
    const requestPlain = (label: string) =>
      requestSendMessage(label, chunk.plainText, plainParams ?? {});
    const result = !chunk.htmlText
      ? await requestPlain("message")
      : await withTelegramHtmlParseFallback({
          label: "message",
          verbose: opts.verbose,
          requestHtml: (label) =>
            requestSendMessage(label, chunk.htmlText ?? chunk.plainText, {
              parse_mode: "HTML" as const,
              ...plainParams,
            }),
          requestPlain,
        });
    return {
      result: result.result,
      acceptedParams: toAcceptedThreadScopedParams(result.acceptedParams),
    };
  };

  const shouldIncludeReplyForChunk = (
    index: number,
    chunkCount: number,
    replyToAlreadyUsed: boolean,
  ) =>
    // Telegram Desktop can render long formatted reply chunks as unsupported messages.
    // Multi-part `first` replies keep chat/topic routing but avoid hiding chunk text.
    !replyToAlreadyUsed && (!singleUseReplyTo || (chunkCount === 1 && index === 0));

  const buildTextParams = (
    index: number,
    chunkCount: number,
    isLastChunk: boolean,
    replyToAlreadyUsed: boolean,
  ) => {
    const params = buildThreadParams(
      shouldIncludeReplyForChunk(index, chunkCount, replyToAlreadyUsed),
    );
    return Object.keys(params).length > 0 || (isLastChunk && replyMarkup)
      ? {
          ...params,
          ...(isLastChunk && replyMarkup ? { reply_markup: replyMarkup } : {}),
        }
      : undefined;
  };

  const buildRichTextParams = (
    index: number,
    chunkCount: number,
    isLastChunk: boolean,
    replyToAlreadyUsed: boolean,
  ) => {
    const params = toTelegramRichMessageContextParams(
      buildThreadParams(shouldIncludeReplyForChunk(index, chunkCount, replyToAlreadyUsed)),
    );
    return Object.keys(params).length > 0 || (isLastChunk && replyMarkup)
      ? {
          ...params,
          ...(isLastChunk && replyMarkup ? { reply_markup: replyMarkup } : {}),
        }
      : undefined;
  };

  const createTextDelivery = (context: string) => {
    let lastMessageId = "";
    let lastChatId = chatId;
    let lastAcceptedParams:
      | TelegramThreadScopedParams
      | TelegramRichMessageContextParams
      | undefined;
    let acceptedReplyToMessageId: number | undefined;
    const messageIds: string[] = [];
    let sentChunkCount = 0;

    const record = async (params: {
      result: TelegramMessageLike;
      acceptedParams?: TelegramThreadScopedParams | TelegramRichMessageContextParams;
      plainText: string;
      finalPart: boolean;
      hasInlineKeyboard: boolean;
    }) => {
      const messageId = resolveTelegramMessageIdOrThrow(params.result, context);
      // Preserve Telegram's accepted identity before fallible observers run so
      // partial errors retain every provider-visible delivery fact.
      lastMessageId = String(messageId);
      lastChatId = String(params.result?.chat?.id ?? chatId);
      lastAcceptedParams = params.acceptedParams;
      acceptedReplyToMessageId ??= resolveAcceptedReplyToMessageId(params.acceptedParams);
      messageIds.push(lastMessageId);
      sentChunkCount += 1;
      recordSentMessage(chatId, messageId, cfg);
      await reportDelivery(messageId, params.result?.chat?.id ?? chatId, {
        telegramDeliveredText: params.plainText,
        telegramHasInlineKeyboard: params.hasInlineKeyboard,
      });
      await recordDeliveredPromptContext(
        {
          message: params.result,
          messageId,
          text: params.plainText,
          ...(params.acceptedParams?.message_thread_id !== undefined
            ? { messageThreadId: params.acceptedParams.message_thread_id }
            : {}),
        },
        params.finalPart,
      );
    };

    const finish = (operation: string): TelegramSendResult => {
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
          chunkCount: sentChunkCount,
        });
      }
      const receipt = buildTelegramTextSendReceipt({
        messageIds,
        chatId: lastChatId,
        messageThreadId: lastAcceptedParams?.message_thread_id,
        replyToMessageId: acceptedReplyToMessageId,
      });
      return {
        messageId: lastMessageId,
        chatId: lastChatId,
        ...(receipt ? { receipt } : {}),
      };
    };

    const partialDeliveryResult = () => {
      const receipt = buildTelegramTextSendReceipt({
        messageIds,
        chatId: lastChatId,
        messageThreadId: lastAcceptedParams?.message_thread_id,
        replyToMessageId: acceptedReplyToMessageId,
      });
      return {
        messageIds: [...messageIds],
        ...(receipt ? { receipt } : {}),
        visibleReplySent: true as const,
      };
    };

    return { record, finish, partialDeliveryResult };
  };

  const sendTelegramTextChunks = async (
    chunks: TelegramTextChunk[],
    context: string,
    options: { replyToAlreadyUsed?: boolean } = {},
  ): Promise<TelegramSendResult> => {
    const delivery = createTextDelivery(context);
    const tracker = createTelegramChunkDeliveryTracker({
      invalidate: () => opts.promptContextProjectionPlan?.cursor.invalidate(),
      onRejected: (error) =>
        logVerbose(
          `telegram ${context} text chunk rejected; continuing: ${formatErrorMessage(error)}`,
        ),
      partialDeliveryResult: delivery.partialDeliveryResult,
    });
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }
      const finalPart = index === chunks.length - 1;
      await tracker.attempt(
        () =>
          sendTelegramTextChunk(
            chunk,
            buildTextParams(index, chunks.length, finalPart, options.replyToAlreadyUsed === true),
          ),
        ({ result, acceptedParams }) =>
          delivery.record({
            result,
            acceptedParams,
            plainText: chunk.plainText,
            finalPart,
            hasInlineKeyboard: finalPart && Boolean(replyMarkup),
          }),
      );
    }
    tracker.finish();
    return delivery.finish("sendMessage");
  };

  const buildChunkedTextPlan = (rawText: string, context: string): TelegramTextChunk[] => {
    if (textMode === "markdown") {
      // Chunk Markdown before rendering so HTML expansion cannot introduce a
      // second mid-word split. Caller-authored HTML keeps its safe splitter below.
      return markdownToTelegramChunks(rawText, 4000, { tableMode }).map((chunk) => ({
        htmlText: chunk.html,
        plainText: telegramHtmlToPlainTextFallback(chunk.html),
      }));
    }
    const htmlText = renderHtmlText(rawText);
    const fallbackText = telegramHtmlToPlainTextFallback(htmlText);
    let htmlChunks: string[];
    try {
      htmlChunks = splitTelegramHtmlChunks(htmlText, 4000);
    } catch (error) {
      logVerbose(
        `telegram ${context} failed HTML chunk planning, retrying as plain text: ${formatErrorMessage(
          error,
        )}`,
      );
      return splitTelegramPlainTextChunks(fallbackText, 4000).map((plainText) => ({ plainText }));
    }
    const fixedPlainTextChunks = splitTelegramPlainTextChunks(fallbackText, 4000);
    if (fixedPlainTextChunks.length > htmlChunks.length) {
      logVerbose(
        `telegram ${context} plain-text fallback needs more chunks than HTML; sending plain text`,
      );
      return fixedPlainTextChunks.map((plainText) => ({ plainText }));
    }
    return htmlChunks.map((htmlTextLocal) => ({
      htmlText: htmlTextLocal,
      plainText: telegramHtmlToPlainTextFallback(htmlTextLocal),
    }));
  };

  const sendChunkedText = async (
    rawText: string,
    context: string,
    options: { replyToAlreadyUsed?: boolean } = {},
  ) => {
    try {
      return useRichMessages
        ? await sendTelegramRichTextChunks(buildRichTextPlan(rawText), context, options)
        : await sendTelegramTextChunks(buildChunkedTextPlan(rawText, context), context, options);
    } catch (error) {
      opts.promptContextProjectionPlan?.cursor.invalidate();
      throw error;
    }
  };

  const buildRichTextPlan = (rawText: string): TelegramRichTextChunk[] => {
    const textLimit = Math.min(
      resolveTextChunkLimit(cfg, "telegram", account.accountId, {
        fallbackLimit: TELEGRAM_RICH_TEXT_LIMIT,
      }),
      TELEGRAM_RICH_TEXT_LIMIT,
    );
    return splitTelegramRichMessageTextChunks({
      text: rawText,
      textLimit,
      tableMode,
      skipEntityDetection: account.config.linkPreview === false,
    });
  };

  const sendTelegramRichTextChunks = async (
    chunks: TelegramRichTextChunk[],
    context: string,
    options: { replyToAlreadyUsed?: boolean } = {},
  ): Promise<TelegramSendResult> => {
    const richRawApi = getTelegramRichRawApi(api);
    const delivery = createTextDelivery(context);
    const tracker = createTelegramChunkDeliveryTracker({
      invalidate: () => opts.promptContextProjectionPlan?.cursor.invalidate(),
      onRejected: (error) =>
        logVerbose(
          `telegram ${context} rich chunk rejected; continuing: ${formatErrorMessage(error)}`,
        ),
      partialDeliveryResult: delivery.partialDeliveryResult,
    });
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }
      const acceptedParams = buildRichTextParams(
        index,
        chunks.length,
        index === chunks.length - 1,
        options.replyToAlreadyUsed === true,
      );
      let result: TelegramMessageLike;
      let recordedParams: TelegramThreadScopedParams | TelegramRichMessageContextParams | undefined;
      if (isEmptyTelegramRichMessage(chunk.richMessage)) {
        // Gate on the rich payload only: valid rich content (media/divider HTML)
        // can have an empty plain projection and must still send.
        sendLogger.warn("telegram richMessage chunk rendered empty; skipping");
        continue;
      }
      try {
        warnTelegramRichBlocksDegradations({
          context: "richMessage",
          reasons: chunk.degradationReasons,
          warn: (message) => sendLogger.warn(message),
        });
        const richResult = await withTelegramNativeQuoteFallback<TelegramMessageLike>({
          label: "richMessage",
          requestParams: acceptedParams ?? {},
          removeNativeQuoteParam: removeTelegramRichNativeQuoteParam,
          request: (effectiveParams, retryLabel) =>
            requestWithChatNotFound(
              () =>
                richRawApi.sendRichMessage({
                  chat_id: chatId,
                  rich_message: chunk.richMessage,
                  ...effectiveParams,
                  ...(opts.silent === true ? { disable_notification: true } : {}),
                }),
              retryLabel,
            ),
        });
        result = richResult.result;
        recordedParams = toTelegramRichMessageContextParams(richResult.acceptedParams);
      } catch (err) {
        const fallbackPlan = buildTelegramPlainFallbackPlan({
          plainText: chunk.plainText,
          err,
          context: "richMessage",
          warn: (message) => sendLogger.warn(message),
        });
        if (!fallbackPlan) {
          tracker.reject(err);
          continue;
        }
        const fallbackChunks = fallbackPlan.chunks;
        const fallbackReplyChunkCount = Math.max(chunks.length, fallbackChunks.length);
        for (let fallbackIndex = 0; fallbackIndex < fallbackChunks.length; fallbackIndex += 1) {
          const fallbackText = fallbackChunks[fallbackIndex] ?? "";
          const fallbackReplyIndex = chunks.length === 1 ? fallbackIndex : index;
          const fallbackParams = buildTextParams(
            fallbackReplyIndex,
            fallbackReplyChunkCount,
            index === chunks.length - 1 && fallbackIndex === fallbackChunks.length - 1,
            options.replyToAlreadyUsed === true,
          );
          const finalPart =
            index === chunks.length - 1 && fallbackIndex === fallbackChunks.length - 1;
          await tracker.attempt(
            () => sendTelegramTextChunk({ plainText: fallbackText }, fallbackParams),
            ({ result: fallbackResult, acceptedParams: fallbackAcceptedParams }) =>
              delivery.record({
                result: fallbackResult,
                acceptedParams: fallbackAcceptedParams,
                plainText: fallbackText,
                finalPart,
                hasInlineKeyboard: finalPart && Boolean(replyMarkup),
              }),
          );
        }
        continue;
      }
      const finalPart = index === chunks.length - 1;
      await tracker.recordAccepted(result, (acceptedResult) =>
        delivery.record({
          result: acceptedResult,
          acceptedParams: recordedParams,
          plainText: chunk.plainText,
          finalPart,
          hasInlineKeyboard: finalPart && Boolean(replyMarkup),
        }),
      );
    }
    tracker.finish();
    return delivery.finish("sendRichMessage");
  };

  return { sendChunkedText };
}

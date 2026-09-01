import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import type { TelegramOutboundPromptContextMessage as TelegramMessageLike } from "./outbound-message-context.js";
import type { TelegramRichMessageContextParams } from "./rich-message.js";
import { isTelegramEmptyContentError } from "./rich-plain-fallback.js";
import {
  logTelegramOutboundSendOk,
  resolveAcceptedReplyToMessageId,
  sendLogger,
  type TelegramApi,
  type TelegramThreadScopedParams,
} from "./send-context.js";
import type { TelegramSendOpts, TelegramSendResult } from "./send-message-types.js";
import type { TelegramPreparedSender } from "./send-prepared.js";
import type { OpenClawConfig } from "./send.runtime.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { planTelegramTextDeliveryPages } from "./telegram-text-delivery.js";
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
  sender: TelegramPreparedSender;
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
    sender,
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

  const createTextDelivery = (context: string, beforeFirstAccepted?: () => Promise<void>) => {
    type PendingChunk = {
      result: TelegramMessageLike;
      messageId: number;
      acceptedParams?: TelegramThreadScopedParams | TelegramRichMessageContextParams;
      plainText: string;
      reportChatId: string | number;
      hasInlineKeyboard: boolean;
    };

    const start = sender.parts.length;
    let lastAcceptedParams:
      | TelegramThreadScopedParams
      | TelegramRichMessageContextParams
      | undefined;
    let acceptedReplyToMessageId: number | undefined;
    const deliveryResults: TelegramSendResult[] = [];
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
      messageId: number;
      result: TelegramMessageLike;
      acceptedParams?: TelegramThreadScopedParams | TelegramRichMessageContextParams;
      plainText: string;
      hasInlineKeyboard: boolean;
    }) => {
      const { messageId } = params;
      lastAcceptedParams = params.acceptedParams;
      acceptedReplyToMessageId ??= resolveAcceptedReplyToMessageId(params.acceptedParams);
      if (sender.parts.length === start + 1) {
        await beforeFirstAccepted?.();
      }
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
      const parts = sender.parts.slice(start);
      const last = parts.at(-1);
      const lastMessageId = last ? String(last.messageId) : "";
      const lastChatId = String(last?.result.chat?.id ?? chatId);
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
          chunkCount: parts.length,
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
        messageIds: sender.parts.slice(start).map((part) => String(part.messageId)),
        ...(receipt ? { receipt } : {}),
        visibleReplySent: true as const,
      };
    };

    const fail = async (error: unknown): Promise<never> => {
      try {
        await flushPending(false);
      } catch (flushError) {
        sendLogger.warn(
          `telegram ${context} delivery bookkeeping cleanup failed: ${formatErrorMessage(flushError)}`,
        );
      }
      return sender.fail(error, start, partialDeliveryResult());
    };

    return { record, finish, fail, partialDeliveryResult };
  };

  const sendChunkedText = async (
    rawText: string,
    context: string,
    options: SendTextOptions = {},
  ): Promise<TelegramSendResult> => {
    const delivery = createTextDelivery(context, options.beforeFirstAccepted);
    const tracking = {
      invalidate: () => opts.promptContextProjectionPlan?.cursor.invalidate(),
      onRejected: (error: unknown) =>
        logVerbose(
          `telegram ${context} text chunk rejected; continuing: ${formatErrorMessage(error)}`,
        ),
      onSilentSkip: (error: unknown) =>
        logVerbose(
          `telegram ${context} text chunk rendered empty; skipping: ${formatErrorMessage(error)}`,
        ),
      partialDeliveryResult: delivery.partialDeliveryResult,
    };
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
      await sender.sendText({
        pages,
        context,
        tracking,
        drainFallback: true,
        observe: delivery.record,
        preparePage: (index) => ({
          requestParams: (fallback) => ({
            ...buildTextParams(
              fallback && pages.length === 1 ? fallback.index : index,
              Math.max(pages.length, fallback?.count ?? pages.length),
              index === pages.length - 1 && (!fallback || fallback.index === fallback.count - 1),
              alreadyUsed,
            ),
            ...(linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {}),
            ...(opts.silent === true ? { disable_notification: true } : {}),
          }),
        }),
      });
      return await delivery.finish(useRichMessages ? "sendRichMessage" : "sendMessage");
    } catch (error) {
      // Terminal/ambiguous failures escape tracker.reject before its invalidate
      // branch; the projection cursor must not claim clean custody for pages
      // that never landed (main's pre-centralization outer-catch contract).
      if (isChannelPartialDeliveryError(error) || !isTelegramEmptyContentError(error)) {
        opts.promptContextProjectionPlan?.cursor.invalidate();
      }
      return await delivery.fail(error);
    }
  };

  return { sendChunkedText };
}

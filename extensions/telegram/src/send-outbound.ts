import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import {
  recordOutboundMessageForPromptContext,
  type TelegramOutboundPromptContextMessage,
} from "./outbound-message-context.js";
import {
  assertTelegramProviderThread,
  resolveTelegramProviderObservedThreadId,
} from "./provider-thread-proof.js";
import {
  buildTelegramThreadReplyParams,
  resolveTelegramSendThreadSpec,
} from "./reply-parameters.js";
import {
  createRequestWithChatNotFound,
  createTelegramNonIdempotentRequestWithDiag,
  createTelegramRequestWithDiag,
  normalizeMessageId,
  resolveAndPersistChatId,
  resolveTelegramMessageIdOrThrow,
  type TelegramApiContext,
} from "./send-context.js";
import type { TelegramSendOpts, TelegramSendResult } from "./send-message-types.js";
import { recordSentMessage } from "./sent-message-cache.js";
import { parseTelegramTarget } from "./targets.js";

type PreparedTelegramOutbound = {
  chatId: string;
  threadSpec?: ReturnType<typeof resolveTelegramSendThreadSpec>;
  threadParams: ReturnType<typeof buildTelegramThreadReplyParams>;
  request: ReturnType<typeof createTelegramRequestWithDiag>;
};

type PreparedTelegramOutboundWithMessageId<T> = PreparedTelegramOutbound &
  (T extends string | number ? { messageId: number } : { messageId?: undefined });

export async function reportTelegramProviderDelivery(params: {
  message: TelegramOutboundPromptContextMessage;
  messageId: string | number;
  fallbackChatId: string | number;
  successfulSendThread?: TelegramThreadSpec;
  kind?: MessageReceiptPartKind;
  meta?: TelegramSendResult["meta"];
  onPrepared?: (delivery: TelegramSendResult) => void;
  onDeliveryResult?: TelegramSendOpts["onDeliveryResult"];
}): Promise<TelegramSendResult> {
  const messageId = String(params.messageId);
  const chatId = String(params.message.chat?.id ?? params.fallbackChatId);
  const providerThreadId = resolveTelegramProviderObservedThreadId({
    message: params.message,
    successfulSendThread: params.successfulSendThread,
  });
  const delivery: TelegramSendResult = {
    messageId,
    chatId,
    ...(providerThreadId !== undefined
      ? {
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ messageId, chatId }],
            ...(params.kind !== undefined ? { kind: params.kind } : {}),
            threadId: String(providerThreadId),
          }),
        }
      : {}),
    ...(params.meta ? { meta: params.meta } : {}),
  };
  params.onPrepared?.(delivery);
  await params.onDeliveryResult?.(delivery);
  try {
    assertTelegramProviderThread({
      message: params.message,
      successfulSendThread: params.successfulSendThread,
    });
  } catch (error) {
    throw createChannelPartialDeliveryError(error, {
      messageIds: [messageId],
      ...(delivery.receipt ? { receipt: delivery.receipt } : {}),
      visibleReplySent: true,
    });
  }
  return delivery;
}

export async function prepareTelegramOutbound<T extends string | number | undefined>(params: {
  to: string | number;
  context: TelegramApiContext;
  opts: Pick<TelegramSendOpts, "verbose" | "retry" | "gatewayClientScopes">;
  messageIdInput?: T;
  thread?: {
    messageThreadId?: number;
    replyToMessageId?: number;
    replyQuoteText?: string;
    useReplyIdAsQuoteSource?: boolean;
  };
  request:
    | { kind: "nonIdempotent"; useApiErrorLogging?: boolean }
    | { kind: "standard"; shouldRetry?: (err: unknown) => boolean };
}): Promise<PreparedTelegramOutboundWithMessageId<T>> {
  const { cfg, account, api } = params.context;
  const rawTarget = String(params.to);
  const target = parseTelegramTarget(rawTarget);
  const chatId = await resolveAndPersistChatId({
    cfg,
    api,
    lookupTarget: target.chatId,
    persistTarget: rawTarget,
    verbose: params.opts.verbose,
    gatewayClientScopes: params.opts.gatewayClientScopes,
  });
  const threadSpec = params.thread
    ? resolveTelegramSendThreadSpec({
        targetMessageThreadId: target.messageThreadId,
        messageThreadId: params.thread.messageThreadId,
        chatType: target.chatType,
      })
    : undefined;
  const threadParams = buildTelegramThreadReplyParams({
    thread: threadSpec,
    replyToMessageId: params.thread?.replyToMessageId,
    replyQuoteText: params.thread?.replyQuoteText,
    useReplyIdAsQuoteSource: params.thread?.useReplyIdAsQuoteSource,
  });
  const requestWithDiag =
    params.request.kind === "nonIdempotent"
      ? createTelegramNonIdempotentRequestWithDiag({
          cfg,
          account,
          retry: params.opts.retry,
          verbose: params.opts.verbose,
          useApiErrorLogging: params.request.useApiErrorLogging,
        })
      : createTelegramRequestWithDiag({
          cfg,
          account,
          retry: params.opts.retry,
          verbose: params.opts.verbose,
          shouldRetry: params.request.shouldRetry,
        });
  const request =
    params.request.kind === "nonIdempotent"
      ? createRequestWithChatNotFound({ requestWithDiag, chatId, input: rawTarget })
      : requestWithDiag;
  return {
    chatId,
    ...(params.messageIdInput !== undefined
      ? { messageId: normalizeMessageId(params.messageIdInput) }
      : {}),
    threadSpec,
    threadParams,
    request,
  } as PreparedTelegramOutboundWithMessageId<T>;
}

export async function finalizeTelegramOutbound(params: {
  context: TelegramApiContext;
  prepared: Pick<PreparedTelegramOutbound, "chatId" | "threadSpec">;
  result: Parameters<typeof recordOutboundMessageForPromptContext>[0]["message"];
  resultContext: string;
  botUserId?: number;
  text?: string;
  messageThreadId?: number;
  promptContextProjectionPlan?: TelegramSendOpts["promptContextProjectionPlan"];
  onDeliveryResult?: TelegramSendOpts["onDeliveryResult"];
  beforeActivity?: (result: { messageId: string; chatId: string }) => void;
}): Promise<TelegramSendResult> {
  const { cfg, account } = params.context;
  const messageId = resolveTelegramMessageIdOrThrow(params.result, params.resultContext);
  recordSentMessage(params.prepared.chatId, messageId, cfg);
  const resultIds = await reportTelegramProviderDelivery({
    message: params.result,
    messageId,
    fallbackChatId: params.prepared.chatId,
    successfulSendThread: params.prepared.threadSpec,
    onDeliveryResult: params.onDeliveryResult,
  });
  const projection = params.promptContextProjectionPlan?.cursor.take(
    params.promptContextProjectionPlan.finalPart,
  );
  const recorded = await recordOutboundMessageForPromptContext({
    cfg,
    account,
    botUserId: params.botUserId,
    chatId: params.prepared.chatId,
    message: params.result,
    messageId,
    text: params.text,
    messageThreadId: params.messageThreadId ?? params.prepared.threadSpec?.id,
    successfulSendThread: params.prepared.threadSpec,
    promptContextProjection: projection,
  });
  if (projection && !recorded) {
    params.promptContextProjectionPlan?.cursor.invalidate();
  }
  params.beforeActivity?.(resultIds);
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "outbound",
  });
  return resultIds;
}

// Telegram plugin module implements reply threading behavior.
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { createTelegramChunkDeliveryTracker } from "../chunk-delivery.js";

export type DeliveryProgress = {
  hasReplied: boolean;
  hasDelivered: boolean;
};

export function resolveReplyToForSend(params: {
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
}): number | undefined {
  return params.replyToId && (params.replyToMode === "all" || !params.progress.hasReplied)
    ? params.replyToId
    : undefined;
}

export function markReplyApplied(progress: DeliveryProgress, replyToId?: number): void {
  if (replyToId && !progress.hasReplied) {
    progress.hasReplied = true;
  }
}

function markDelivered(progress: DeliveryProgress): void {
  progress.hasDelivered = true;
}

export async function sendChunkedTelegramReplyText<
  TChunk,
  TReplyMarkup = unknown,
  TProgress extends DeliveryProgress = DeliveryProgress,
>(params: {
  chunks: readonly TChunk[];
  progress: TProgress;
  replyToId?: number;
  replyToMode: ReplyToMode;
  replyMarkup?: TReplyMarkup;
  replyQuoteText?: string;
  quoteOnlyOnFirstChunk?: boolean;
  invalidate: () => void;
  onRejected: (error: unknown) => void;
  isSilentSkip?: (error: unknown) => boolean;
  onSilentSkip?: (error: unknown) => void;
  markDelivered?: (progress: TProgress) => void;
  sendChunk: (opts: {
    chunk: TChunk;
    isFirstChunk: boolean;
    replyToMessageId?: number;
    replyMarkup?: TReplyMarkup;
    replyQuoteText?: string;
  }) => Promise<number>;
  recordChunk: (result: number, chunk: TChunk) => Promise<void>;
}): Promise<void> {
  const applyDelivered = params.markDelivered ?? markDelivered;
  const messageIds: string[] = [];
  const tracker = createTelegramChunkDeliveryTracker({
    invalidate: params.invalidate,
    onRejected: params.onRejected,
    isSilentSkip: params.isSilentSkip,
    onSilentSkip: params.onSilentSkip,
    partialDeliveryResult: () => ({ messageIds: [...messageIds], visibleReplySent: true }),
  });
  const suppressSingleUseReply =
    params.chunks.length > 1 && isSingleUseReplyToMode(params.replyToMode);
  let hasAcceptedChunk = false;
  for (const chunk of params.chunks) {
    if (!chunk) {
      continue;
    }
    const isFirstChunk = !hasAcceptedChunk;
    // Telegram Desktop can render long formatted native-reply chunks as
    // unsupported messages. Multi-part `first` replies consume the reply target
    // without adding native reply params, preserving visible text.
    const replyToMessageId = suppressSingleUseReply
      ? undefined
      : resolveReplyToForSend({
          replyToId: params.replyToId,
          replyToMode: params.replyToMode,
          progress: params.progress,
        });
    const shouldAttachQuote =
      Boolean(replyToMessageId) &&
      Boolean(params.replyQuoteText) &&
      (params.quoteOnlyOnFirstChunk !== true || isFirstChunk);
    const accepted = await tracker.attempt(
      () =>
        params.sendChunk({
          chunk,
          isFirstChunk,
          replyToMessageId,
          replyMarkup: isFirstChunk ? params.replyMarkup : undefined,
          replyQuoteText: shouldAttachQuote ? params.replyQuoteText : undefined,
        }),
      (result) => {
        // Capture Telegram's accepted identity before fallible bookkeeping so
        // partial delivery reports retain the concrete streamed messages.
        messageIds.push(String(result));
        return params.recordChunk(result, chunk);
      },
    );
    if (accepted !== "accepted") {
      continue;
    }
    hasAcceptedChunk = true;
    markReplyApplied(
      params.progress,
      suppressSingleUseReply && isFirstChunk ? params.replyToId : replyToMessageId,
    );
    applyDelivered(params.progress);
  }
  tracker.finish();
}

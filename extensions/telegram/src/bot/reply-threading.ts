import type { ReplyToMode } from "openclaw/plugin-sdk/config-types";

export type DeliveryProgress = {
  hasReplied: boolean;
  hasDelivered: boolean;
};

export function createDeliveryProgress(): DeliveryProgress {
  return {
    hasReplied: false,
    hasDelivered: false,
  };
}

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

export function markDelivered(progress: DeliveryProgress): void {
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
  markDelivered?: (progress: TProgress) => void;
  sendChunk: (opts: {
    chunk: TChunk;
    isFirstChunk: boolean;
    replyToMessageId?: number;
    replyMarkup?: TReplyMarkup;
    replyQuoteText?: string;
  }) => Promise<void>;
}): Promise<void> {
  const applyDelivered = params.markDelivered ?? markDelivered;
  for (let i = 0; i < params.chunks.length; i += 1) {
    const chunk = params.chunks[i];
    if (!chunk) {
      continue;
    }
    const isFirstChunk = i === 0;
    const replyToMessageId = resolveReplyToForSend({
      replyToId: params.replyToId,
      replyToMode: params.replyToMode,
      progress: params.progress,
    });
    const shouldAttachQuote =
      Boolean(replyToMessageId) &&
      Boolean(params.replyQuoteText) &&
      (params.quoteOnlyOnFirstChunk !== true || isFirstChunk);
    await params.sendChunk({
      chunk,
      isFirstChunk,
      replyToMessageId,
      replyMarkup: isFirstChunk ? params.replyMarkup : undefined,
      replyQuoteText: shouldAttachQuote ? params.replyQuoteText : undefined,
    });
    markReplyApplied(params.progress, replyToMessageId);
    applyDelivered(params.progress);
  }
}

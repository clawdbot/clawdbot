// Coalesces buffered block-streaming payloads into sendable reply parts.
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { copyReplyPayloadMetadata, isReplyPayloadStatusNotice } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";

/** Coalesces many streaming reply fragments into fewer outbound payloads. */
type BlockReplyCoalescer = {
  enqueue: (payload: ReplyPayload) => void;
  flush: (options?: { force?: boolean }) => Promise<void>;
  hasBuffered: () => boolean;
  stop: () => void;
};

/** Creates a text coalescer with idle and size-based flush behavior. */
export function createBlockReplyCoalescer(params: {
  config: BlockStreamingCoalescing;
  shouldAbort: () => boolean;
  onFlush: (payload: ReplyPayload) => Promise<void> | void;
}): BlockReplyCoalescer {
  const { config, shouldAbort, onFlush } = params;
  const minChars = Math.max(1, Math.floor(config.minChars));
  const maxChars = Math.max(minChars, Math.floor(config.maxChars));
  const idleMs = Math.max(0, Math.floor(config.idleMs));
  const joiner = config.joiner ?? "";
  const flushOnEnqueue = config.flushOnEnqueue === true;

  let bufferText = "";
  let bufferedPayload: ReplyPayload | undefined;
  let idleTimer: NodeJS.Timeout | undefined;

  const clearIdleTimer = () => {
    if (!idleTimer) {
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const resetBuffer = () => {
    bufferText = "";
    bufferedPayload = undefined;
  };

  const scheduleIdleFlush = () => {
    if (idleMs <= 0) {
      return;
    }
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      void flush({ force: false });
    }, idleMs);
  };

  const flush = async (options?: { force?: boolean }) => {
    clearIdleTimer();
    if (shouldAbort()) {
      resetBuffer();
      return;
    }
    if (!bufferText || !bufferedPayload) {
      return;
    }
    if (!options?.force && !flushOnEnqueue && bufferText.length < minChars) {
      scheduleIdleFlush();
      return;
    }
    const payload = copyReplyPayloadMetadata(bufferedPayload, {
      ...bufferedPayload,
      text: bufferText,
    });
    resetBuffer();
    await onFlush(payload);
  };

  const canMergeBufferedTextWithMedia = (payload: ReplyPayload) =>
    Boolean(bufferText) &&
    bufferedPayload !== undefined &&
    !flushOnEnqueue &&
    !bufferedPayload.audioAsVoice &&
    !payload.audioAsVoice &&
    !payload.isReasoning &&
    !payload.isCommentary &&
    !isReplyPayloadStatusNotice(payload) &&
    !bufferedPayload.isReasoning &&
    !bufferedPayload.isCommentary &&
    !isReplyPayloadStatusNotice(bufferedPayload) &&
    (!payload.replyToId || bufferedPayload.replyToId === payload.replyToId);

  /** Merges buffered text into a media payload without changing media metadata. */
  const mergeBufferedTextWithMedia = (payload: ReplyPayload, text: string): ReplyPayload => {
    const mergedText = text ? `${bufferText}${joiner}${text}` : bufferText;
    const mergedPayload: ReplyPayload = {
      ...bufferedPayload,
      ...payload,
      text: mergedText,
      replyToId: payload.replyToId ?? bufferedPayload?.replyToId,
      replyToCurrent: payload.replyToCurrent || bufferedPayload?.replyToCurrent,
      replyToTag: payload.replyToTag || bufferedPayload?.replyToTag,
    };
    const metadataMergedPayload = copyReplyPayloadMetadata(
      bufferedPayload ?? mergedPayload,
      mergedPayload,
    );
    resetBuffer();
    return copyReplyPayloadMetadata(payload, metadataMergedPayload);
  };

  const enqueue = (payload: ReplyPayload) => {
    if (shouldAbort()) {
      return;
    }
    const reply = resolveSendableOutboundReplyParts(payload);
    const hasMedia = reply.hasMedia;
    const text = reply.text;
    const hasText = reply.hasText;
    if (hasMedia) {
      if (canMergeBufferedTextWithMedia(payload)) {
        void onFlush(mergeBufferedTextWithMedia(payload, text));
        return;
      }
      void flush({ force: true });
      void onFlush(payload);
      return;
    }
    if (!hasText) {
      return;
    }

    // When flushOnEnqueue is set, treat each enqueued payload as its own outbound block
    // and flush immediately instead of waiting for coalescing thresholds.
    if (flushOnEnqueue) {
      if (bufferText) {
        void flush({ force: true });
      }
      bufferedPayload = payload;
      bufferText = text;
      void flush({ force: true });
      return;
    }

    const replyToConflict = Boolean(
      bufferText &&
      payload.replyToId &&
      (!bufferedPayload?.replyToId || bufferedPayload.replyToId !== payload.replyToId),
    );
    const visibilityConflict =
      bufferText &&
      bufferedPayload &&
      (bufferedPayload.isReasoning !== payload.isReasoning ||
        bufferedPayload.isCommentary !== payload.isCommentary ||
        bufferedPayload.isCompactionNotice !== payload.isCompactionNotice ||
        bufferedPayload.isFallbackNotice !== payload.isFallbackNotice ||
        isReplyPayloadStatusNotice(bufferedPayload) !== isReplyPayloadStatusNotice(payload));
    // Flush before changing reply target, audio mode, or visibility class.
    if (
      bufferText &&
      (replyToConflict ||
        bufferedPayload?.audioAsVoice !== payload.audioAsVoice ||
        visibilityConflict)
    ) {
      void flush({ force: true });
    }

    if (!bufferText) {
      bufferedPayload = payload;
    }

    const nextText = bufferText ? `${bufferText}${joiner}${text}` : text;
    if (nextText.length > maxChars) {
      if (bufferText) {
        void flush({ force: true });
        bufferedPayload = payload;
        if (text.length >= maxChars) {
          void onFlush(payload);
          return;
        }
        bufferText = text;
        scheduleIdleFlush();
        return;
      }
      void onFlush(payload);
      return;
    }

    bufferText = nextText;
    if (bufferText.length >= maxChars) {
      void flush({ force: true });
      return;
    }
    scheduleIdleFlush();
  };

  return {
    enqueue,
    flush,
    hasBuffered: () => Boolean(bufferText),
    stop: () => clearIdleTimer(),
  };
}

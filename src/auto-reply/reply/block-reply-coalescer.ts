// Coalesces buffered block-streaming payloads into sendable reply parts.
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { copyReplyPayloadMetadata, isReplyPayloadStatusNotice } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";

/** Coalesces many streaming reply fragments into fewer outbound payloads. */
export type BlockReplyCoalescer = {
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
  let bufferReplyToId: ReplyPayload["replyToId"];
  let bufferAudioAsVoice: ReplyPayload["audioAsVoice"];
  let bufferIsReasoning: ReplyPayload["isReasoning"];
  let bufferIsCompactionNotice: ReplyPayload["isCompactionNotice"];
  let bufferIsFallbackNotice: ReplyPayload["isFallbackNotice"];
  let bufferIsStatusNotice: ReplyPayload["isStatusNotice"];
  let bufferMetadataSource: ReplyPayload | undefined;
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
    bufferReplyToId = undefined;
    bufferAudioAsVoice = undefined;
    bufferIsReasoning = undefined;
    bufferIsCompactionNotice = undefined;
    bufferIsFallbackNotice = undefined;
    bufferIsStatusNotice = undefined;
    bufferMetadataSource = undefined;
  };

  const startBufferFromPayload = (payload: ReplyPayload) => {
    bufferReplyToId = payload.replyToId;
    bufferAudioAsVoice = payload.audioAsVoice;
    bufferIsReasoning = payload.isReasoning;
    bufferIsCompactionNotice = payload.isCompactionNotice;
    bufferIsFallbackNotice = payload.isFallbackNotice;
    bufferIsStatusNotice = payload.isStatusNotice;
    bufferMetadataSource = payload;
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
    if (!bufferText) {
      return;
    }
    if (!options?.force && !flushOnEnqueue && bufferText.length < minChars) {
      scheduleIdleFlush();
      return;
    }
    const payload: ReplyPayload = {
      text: bufferText,
      replyToId: bufferReplyToId,
      audioAsVoice: bufferAudioAsVoice,
      isReasoning: bufferIsReasoning,
      isCompactionNotice: bufferIsCompactionNotice,
      isFallbackNotice: bufferIsFallbackNotice,
      isStatusNotice: bufferIsStatusNotice,
    };
    const payloadWithMetadata = copyReplyPayloadMetadata(bufferMetadataSource ?? payload, payload);
    resetBuffer();
    await onFlush(payloadWithMetadata);
  };

  const canMergeBufferedTextWithMedia = (payload: ReplyPayload) =>
    Boolean(bufferText) &&
    !flushOnEnqueue &&
    !bufferAudioAsVoice &&
    !payload.audioAsVoice &&
    !payload.isReasoning &&
    !isReplyPayloadStatusNotice(payload) &&
    !bufferIsReasoning &&
    !isReplyPayloadStatusNotice({
      isCompactionNotice: bufferIsCompactionNotice,
      isFallbackNotice: bufferIsFallbackNotice,
      isStatusNotice: bufferIsStatusNotice,
    }) &&
    (!payload.replyToId || bufferReplyToId === payload.replyToId);

  /** Merges buffered text into a media payload without changing media metadata. */
  const mergeBufferedTextWithMedia = (payload: ReplyPayload, text: string): ReplyPayload => {
    const mergedText = text ? `${bufferText}${joiner}${text}` : bufferText;
    const mergedPayload: ReplyPayload = {
      ...payload,
      text: mergedText,
      replyToId: payload.replyToId ?? bufferReplyToId,
    };
    const metadataMergedPayload = copyReplyPayloadMetadata(
      bufferMetadataSource ?? mergedPayload,
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
      startBufferFromPayload(payload);
      bufferText = text;
      void flush({ force: true });
      return;
    }

    const replyToConflict = Boolean(
      bufferText &&
      payload.replyToId &&
      (!bufferReplyToId || bufferReplyToId !== payload.replyToId),
    );
    const visibilityConflict =
      bufferText &&
      (bufferIsReasoning !== payload.isReasoning ||
        bufferIsCompactionNotice !== payload.isCompactionNotice ||
        bufferIsFallbackNotice !== payload.isFallbackNotice ||
        isReplyPayloadStatusNotice({
          isCompactionNotice: bufferIsCompactionNotice,
          isFallbackNotice: bufferIsFallbackNotice,
          isStatusNotice: bufferIsStatusNotice,
        }) !== isReplyPayloadStatusNotice(payload));
    // Flush before changing reply target, audio mode, or visibility class.
    if (
      bufferText &&
      (replyToConflict || bufferAudioAsVoice !== payload.audioAsVoice || visibilityConflict)
    ) {
      void flush({ force: true });
    }

    if (!bufferText) {
      startBufferFromPayload(payload);
    }

    const nextText = bufferText ? `${bufferText}${joiner}${text}` : text;
    if (nextText.length > maxChars) {
      if (bufferText) {
        void flush({ force: true });
        startBufferFromPayload(payload);
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

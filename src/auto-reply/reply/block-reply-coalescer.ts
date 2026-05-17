import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "../types.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";

export type BlockReplyCoalescer = {
  enqueue: (payload: ReplyPayload) => void;
  flush: (options?: { force?: boolean }) => Promise<void>;
  hasBuffered: () => boolean;
  stop: () => void;
};

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
    };
    resetBuffer();
    await onFlush(payload);
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
      bufferReplyToId = payload.replyToId;
      bufferAudioAsVoice = payload.audioAsVoice;
      bufferIsReasoning = payload.isReasoning;
      bufferIsCompactionNotice = payload.isCompactionNotice;
      bufferIsFallbackNotice = payload.isFallbackNotice;
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
        bufferIsFallbackNotice !== payload.isFallbackNotice);
    if (
      bufferText &&
      (replyToConflict || bufferAudioAsVoice !== payload.audioAsVoice || visibilityConflict)
    ) {
      void flush({ force: true });
    }

    if (!bufferText) {
      bufferReplyToId = payload.replyToId;
      bufferAudioAsVoice = payload.audioAsVoice;
      bufferIsReasoning = payload.isReasoning;
      bufferIsCompactionNotice = payload.isCompactionNotice;
      bufferIsFallbackNotice = payload.isFallbackNotice;
    }

    const nextText = bufferText ? `${bufferText}${joiner}${text}` : text;
    if (nextText.length > maxChars) {
      if (bufferText) {
        void flush({ force: true });
        bufferReplyToId = payload.replyToId;
        bufferAudioAsVoice = payload.audioAsVoice;
        bufferIsReasoning = payload.isReasoning;
        bufferIsCompactionNotice = payload.isCompactionNotice;
        bufferIsFallbackNotice = payload.isFallbackNotice;
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

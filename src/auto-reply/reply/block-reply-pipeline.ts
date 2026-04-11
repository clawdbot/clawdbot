import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "../../globals.js";
import type { ReplyPayload } from "../types.js";
import { createBlockReplyCoalescer } from "./block-reply-coalescer.js";
import type { BlockStreamingCoalescing } from "./block-streaming.js";

export type BlockReplyPipeline = {
  enqueue: (payload: ReplyPayload) => void;
  flush: (options?: { force?: boolean }) => Promise<void>;
  stop: () => void;
  hasBuffered: () => boolean;
  didStream: () => boolean;
  isAborted: () => boolean;
  hasSentPayload: (payload: ReplyPayload) => boolean;
};

export type BlockReplyBuffer = {
  shouldBuffer: (payload: ReplyPayload) => boolean;
  onEnqueue?: (payload: ReplyPayload) => void;
  finalize?: (payload: ReplyPayload) => ReplyPayload;
};

export function createAudioAsVoiceBuffer(params: {
  isAudioPayload: (payload: ReplyPayload) => boolean;
}): BlockReplyBuffer {
  let seenAudioAsVoice = false;
  return {
    onEnqueue: (payload) => {
      if (payload.audioAsVoice) {
        seenAudioAsVoice = true;
      }
    },
    shouldBuffer: (payload) => params.isAudioPayload(payload),
    finalize: (payload) => (seenAudioAsVoice ? { ...payload, audioAsVoice: true } : payload),
  };
}

export function createBlockReplyPayloadKey(payload: ReplyPayload): string {
  const reply = resolveSendableOutboundReplyParts(payload);
  return JSON.stringify({
    text: reply.trimmedText,
    mediaList: reply.mediaUrls,
    replyToId: payload.replyToId ?? null,
  });
}

export function createBlockReplyContentKey(payload: ReplyPayload): string {
  const reply = resolveSendableOutboundReplyParts(payload);
  // Content-only key used for final-payload suppression after block streaming.
  // This intentionally ignores replyToId so a streamed threaded payload and the
  // later final payload still collapse when they carry the same content.
  return JSON.stringify({ text: reply.trimmedText, mediaList: reply.mediaUrls });
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
): Promise<T> => {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export function createBlockReplyPipeline(params: {
  onBlockReply: (
    payload: ReplyPayload,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ) => Promise<void> | void;
  timeoutMs: number;
  coalescing?: BlockStreamingCoalescing;
  buffer?: BlockReplyBuffer;
}): BlockReplyPipeline {
  const { onBlockReply, timeoutMs, coalescing, buffer } = params;
  const sentKeys = new Set<string>();
  const sentContentKeys = new Set<string>();
  const pendingKeys = new Set<string>();
  const seenKeys = new Set<string>();
  const bufferedKeys = new Set<string>();
  const bufferedPayloadKeys = new Set<string>();
  const bufferedPayloads: ReplyPayload[] = [];
  let sendChain: Promise<void> = Promise.resolve();
  let aborted = false;
  let didStream = false;
  let didLogTimeout = false;

  const sendPayload = (payload: ReplyPayload, bypassSeenCheck: boolean = false) => {
    if (aborted) {
      return;
    }
    const payloadKey = createBlockReplyPayloadKey(payload);
    const contentKey = createBlockReplyContentKey(payload);
    if (!bypassSeenCheck) {
      if (seenKeys.has(payloadKey)) {
        return;
      }
      seenKeys.add(payloadKey);
    }
    if (sentKeys.has(payloadKey) || pendingKeys.has(payloadKey)) {
      return;
    }
    pendingKeys.add(payloadKey);

    const timeoutError = new Error(`block reply delivery timed out after ${timeoutMs}ms`);
    const abortController = new AbortController();
    sendChain = sendChain
      .then(async () => {
        if (aborted) {
          return false;
        }
        await withTimeout(
          Promise.resolve(
            onBlockReply(payload, {
              abortSignal: abortController.signal,
              timeoutMs,
            }),
          ),
          timeoutMs,
          timeoutError,
        );
        return true;
      })
      .then((didSend) => {
        if (!didSend) {
          return;
        }
        sentKeys.add(payloadKey);
        sentContentKeys.add(contentKey);
        didStream = true;
      })
      .catch((err) => {
        if (err === timeoutError) {
          abortController.abort();
          aborted = true;
          if (!didLogTimeout) {
            didLogTimeout = true;
            logVerbose(
              `block reply delivery timed out after ${timeoutMs}ms; skipping remaining block replies to preserve ordering`,
            );
          }
          return;
        }
        logVerbose(`block reply delivery failed: ${String(err)}`);
      })
      .finally(() => {
        pendingKeys.delete(payloadKey);
      });
  };

  const coalescer = coalescing
    ? createBlockReplyCoalescer({
        config: coalescing,
        shouldAbort: () => aborted,
        onFlush: (payload) => {
          bufferedKeys.clear();
          sendPayload(payload, /* bypassSeenCheck */ true);
        },
      })
    : null;

  const bufferPayload = (payload: ReplyPayload) => {
    buffer?.onEnqueue?.(payload);
    if (!buffer?.shouldBuffer(payload)) {
      return false;
    }
    const payloadKey = createBlockReplyPayloadKey(payload);
    if (
      seenKeys.has(payloadKey) ||
      sentKeys.has(payloadKey) ||
      pendingKeys.has(payloadKey) ||
      bufferedPayloadKeys.has(payloadKey)
    ) {
      return true;
    }
    seenKeys.add(payloadKey);
    bufferedPayloadKeys.add(payloadKey);
    bufferedPayloads.push(payload);
    return true;
  };

  const flushBuffered = () => {
    if (!bufferedPayloads.length) {
      return;
    }
    for (const payload of bufferedPayloads) {
      const finalPayload = buffer?.finalize?.(payload) ?? payload;
      sendPayload(finalPayload, /* bypassSeenCheck */ true);
    }
    bufferedPayloads.length = 0;
    bufferedPayloadKeys.clear();
  };

  const enqueue = (payload: ReplyPayload) => {
    if (aborted) {
      return;
    }
    if (bufferPayload(payload)) {
      return;
    }
    const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
    if (hasMedia) {
      void coalescer?.flush({ force: true });
      sendPayload(payload, /* bypassSeenCheck */ false);
      return;
    }
    if (coalescer) {
      const payloadKey = createBlockReplyPayloadKey(payload);
      if (seenKeys.has(payloadKey) || pendingKeys.has(payloadKey) || bufferedKeys.has(payloadKey)) {
        return;
      }
      seenKeys.add(payloadKey);
      bufferedKeys.add(payloadKey);
      coalescer.enqueue(payload);
      return;
    }
    sendPayload(payload, /* bypassSeenCheck */ false);
  };

  const flush = async (options?: { force?: boolean }) => {
    await coalescer?.flush(options);
    flushBuffered();
    await sendChain;
  };

  const stop = () => {
    coalescer?.stop();
  };

  return {
    enqueue,
    flush,
    stop,
    hasBuffered: () => coalescer?.hasBuffered() || bufferedPayloads.length > 0,
    didStream: () => didStream,
    isAborted: () => aborted,
    hasSentPayload: (payload) => {
      const payloadKey = createBlockReplyContentKey(payload);
      return sentContentKeys.has(payloadKey);
    },
  };
}

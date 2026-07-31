// WhatsApp inbound media chunk-idle timeout helpers.
import { saveMediaStream, type SavedMedia } from "openclaw/plugin-sdk/media-store";

/**
 * Default per-chunk idle timeout for WhatsApp inbound media downloads.
 * Matches Telegram `TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000` so a stalled
 * Baileys media stream cannot block inbound dispatch indefinitely.
 */
export const WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS = 30_000;

class WhatsAppInboundMediaTimeoutError extends Error {
  readonly chunkTimeoutMs: number;
  constructor(chunkTimeoutMs: number) {
    super(`WhatsApp media download stalled: no data received for ${chunkTimeoutMs}ms`);
    this.name = "WhatsAppInboundMediaTimeoutError";
    this.chunkTimeoutMs = chunkTimeoutMs;
  }
}

function destroySource(source: unknown) {
  const s = source as { destroy?: (err?: Error) => void };
  if (typeof s.destroy === "function") {
    s.destroy(new WhatsAppInboundMediaTimeoutError(0));
  }
}

// Bound each AsyncIterable `next()` so a stalled Baileys download cannot hang
// inbound dispatch. On timeout, destroy the source (if it supports destroy) so
// the underlying Readable/HTTP resource closes, then call `return()` without
// awaiting. Silence the losing `nextPromise` to avoid unhandledRejection.
//
// IMPORTANT: do NOT `await` iterator.return() in the finally block. Node
// Readable async-iterator `return()` hangs when the underlying source is
// stalled (the iterator waits for a `readable` event that never fires). The
// source is explicitly destroyed before reaching the finally block so the
// underlying resource is released regardless.
function withChunkIdleTimeout<T>(
  source: AsyncIterable<T>,
  chunkTimeoutMs: number,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      try {
        while (true) {
          const nextPromise = iterator.next();
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new WhatsAppInboundMediaTimeoutError(chunkTimeoutMs)),
              chunkTimeoutMs,
            );
          });
          let result: IteratorResult<T>;
          try {
            result = await Promise.race([nextPromise, timeoutPromise]);
          } catch (err) {
            // Destroy the source so the underlying Readable resource closes;
            // then silence the pending next() to avoid unhandledRejection.
            destroySource(source);
            nextPromise.then(
              () => undefined,
              () => undefined,
            );
            throw err;
          } finally {
            if (timeoutHandle !== undefined) {
              clearTimeout(timeoutHandle);
            }
          }
          if (result.done) {
            return;
          }
          yield result.value;
        }
      } finally {
        if (typeof iterator.return === "function") {
          iterator.return().catch(() => undefined);
        }
      }
    },
  };
}

/** Production idle-wrap for Baileys media streams (loopback-proof seam). */
export function saveInboundMediaStreamWithIdleTimeout(
  stream: AsyncIterable<unknown>,
  contentType: string | undefined,
  maxBytes: number,
  fileName?: string,
  chunkTimeoutMs: number = WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS,
): Promise<SavedMedia> {
  return saveMediaStream(
    withChunkIdleTimeout(stream, chunkTimeoutMs),
    contentType,
    "inbound",
    maxBytes,
    fileName,
  );
}

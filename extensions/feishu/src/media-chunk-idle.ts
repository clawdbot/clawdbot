// Feishu inbound media chunk-idle timeout helper.
import { saveMediaStream, type SavedMedia } from "openclaw/plugin-sdk/media-store";

class FeishuInboundMediaTimeoutError extends Error {
  readonly chunkTimeoutMs: number;
  constructor(chunkTimeoutMs: number) {
    super(`Feishu media download stalled: no data received for ${chunkTimeoutMs}ms`);
    this.name = "FeishuInboundMediaTimeoutError";
    this.chunkTimeoutMs = chunkTimeoutMs;
  }
}

function destroySource(source: unknown) {
  const s = source as { destroy?: () => void };
  if (typeof s.destroy === "function") {
    s.destroy();
  }
}

// Bound each AsyncIterable `next()` so a stalled Lark download cannot hang
// inbound dispatch. Destroying the source on timeout releases the SDK's
// underlying Node Readable and HTTP connection.
function withChunkIdleTimeout<T>(
  source: AsyncIterable<T>,
  chunkTimeoutMs: number,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      let exhausted = false;
      try {
        while (true) {
          const nextPromise = iterator.next();
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(new FeishuInboundMediaTimeoutError(chunkTimeoutMs));
              try {
                destroySource(source);
              } catch {
                // Teardown is best-effort; the timeout must remain authoritative.
              }
            }, chunkTimeoutMs);
          });
          let result: IteratorResult<T>;
          try {
            result = await Promise.race([nextPromise, timeoutPromise]);
          } finally {
            if (timeoutHandle !== undefined) {
              clearTimeout(timeoutHandle);
            }
          }
          if (result.done) {
            exhausted = true;
            return;
          }
          yield result.value;
        }
      } finally {
        if (!exhausted && typeof iterator.return === "function") {
          // A stalled Node Readable can keep return() pending. Source teardown
          // already owns cleanup, so observe the promise without awaiting it.
          iterator.return().catch(() => undefined);
        }
      }
    },
  };
}

export function saveMediaStreamWithIdleTimeout(
  stream: AsyncIterable<unknown>,
  contentType: string | undefined,
  maxBytes: number,
  fileName: string | undefined,
  chunkTimeoutMs: number,
): Promise<SavedMedia> {
  return saveMediaStream(
    withChunkIdleTimeout(stream, chunkTimeoutMs),
    contentType,
    "inbound",
    maxBytes,
    fileName,
  );
}

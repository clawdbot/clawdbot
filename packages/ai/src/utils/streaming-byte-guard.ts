/**
 * Bounded SSE / NDJSON stream reader guard.
 *
 * Wraps a `ReadableStreamDefaultReader<Uint8Array>` so the caller's existing
 * chunk-by-chunk parsing logic is unchanged, but accumulated bytes are tracked
 * against a hard cap. On overflow the underlying reader is cancelled and a
 * canonical error is thrown. Mirrors the `readResponseWithLimit` / bounded
 * JSON response pattern (see `src/agents/provider-http-errors.ts`).
 *
 * Internal helper for now. If extensions need it, promote to a plugin-SDK
 * subpath in a separate, dedicated PR with full SDK metadata sync.
 */

export type SseStreamOverflow = {
  size: number;
  maxBytes: number;
};

export type ReadSseStreamWithLimitOptions = {
  maxBytes: number;
  onOverflow?: (params: SseStreamOverflow) => Error;
};

export type SseByteGuard = {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(reason?: unknown): Promise<void>;
  totalBytes(): number;
  overflowed(): boolean;
  cancelled(): boolean;
};

export function createSseByteGuard(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: ReadSseStreamWithLimitOptions,
): SseByteGuard {
  if (!Number.isFinite(opts.maxBytes) || opts.maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative finite number: ${opts.maxBytes}`);
  }
  const onOverflow =
    opts.onOverflow ??
    ((params) =>
      new Error(`SSE stream exceeds ${params.maxBytes} bytes (received ${params.size})`));
  let total = 0;
  let overflowedFlag = false;
  let cancelledFlag = false;
  return {
    read: async () => {
      if (overflowedFlag || cancelledFlag) {
        return { done: true, value: undefined };
      }
      const result = await reader.read();
      if (result.done) {
        return result;
      }
      const chunkLen = result.value?.byteLength ?? 0;
      const next = total + chunkLen;
      if (next > opts.maxBytes) {
        overflowedFlag = true;
        cancelledFlag = true;
        const err = onOverflow({ size: next, maxBytes: opts.maxBytes });
        try {
          await reader.cancel(err);
        } catch {
          // best-effort cancellation; caller observes the overflow error
        }
        throw err;
      }
      total = next;
      return result;
    },
    cancel: async (reason?: unknown) => {
      if (overflowedFlag) {
        // overflow already set cancelledFlag; do not overwrite
        return;
      }
      cancelledFlag = true;
      try {
        await reader.cancel(reason);
      } catch {
        // best-effort cancellation
      }
    },
    totalBytes: () => total,
    overflowed: () => overflowedFlag,
    cancelled: () => cancelledFlag,
  };
}

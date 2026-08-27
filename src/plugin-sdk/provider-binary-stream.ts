/** Create a byte-limited stream that owns its source reader and request cleanup. */
export function createBoundedProviderBinaryStream(
  source: ReadableStream<Uint8Array>,
  options: {
    maxBytes: number;
    createOverflowError: (params: { size: number; maxBytes: number }) => Error;
    createReleaseError: () => Error;
    cleanup: () => Promise<void>;
  },
): { stream: ReadableStream<Uint8Array>; release: () => Promise<void> } {
  // Keep direct reader ownership: transform writer rejection can leak when
  // playback cancellation races overflow.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined = source.getReader();
  let completion: Promise<PromiseSettledResult<void>> | undefined;
  let pendingError: Error | undefined;
  let totalBytes = 0;

  const releaseReader = (activeReader: ReadableStreamDefaultReader<Uint8Array>) => {
    if (reader !== activeReader) {
      return;
    }
    reader = undefined;
    activeReader.releaseLock();
  };

  const finalize = (reason?: unknown) => {
    // Memoize before callbacks can reenter. Start cancellation before request
    // cleanup, but await both so cleanup can abort a retained capture tee.
    return (completion ??= Promise.resolve().then(async () => {
      const activeReader = reader;
      const [cancellation, cleanup] = await Promise.allSettled([
        activeReader?.cancel(reason),
        (async () => {
          try {
            if (activeReader) {
              releaseReader(activeReader);
            }
          } finally {
            await options.cleanup();
          }
        })(),
      ]);
      if (cleanup.status === "rejected") {
        throw cleanup.reason;
      }
      return cancellation;
    }));
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pendingError) {
        const error = pendingError;
        pendingError = undefined;
        controller.error(error);
        return;
      }
      const activeReader = reader;
      if (!activeReader) {
        controller.close();
        return;
      }
      try {
        const chunk = await activeReader.read();
        if (chunk.done) {
          releaseReader(activeReader);
          controller.close();
          return;
        }
        const nextSize = totalBytes + chunk.value.byteLength;
        const remainingBytes = options.maxBytes - totalBytes;
        if (chunk.value.byteLength > remainingBytes) {
          const error = options.createOverflowError({
            size: nextSize,
            maxBytes: options.maxBytes,
          });
          if (remainingBytes > 0) {
            controller.enqueue(chunk.value.subarray(0, remainingBytes));
            pendingError = error;
          }
          // Preserve the overflow outcome even if request cleanup is delayed or fails.
          void finalize(error).catch(() => undefined);
          if (remainingBytes <= 0) {
            controller.error(error);
          }
          return;
        }
        totalBytes = nextSize;
        controller.enqueue(chunk.value);
      } catch (error) {
        releaseReader(activeReader);
        controller.error(error);
      }
    },
    async cancel(reason) {
      const cancellation = await finalize(reason);
      if (cancellation.status === "rejected") {
        throw cancellation.reason;
      }
    },
  });

  return {
    stream,
    release: async () => {
      await finalize(options.createReleaseError());
    },
  };
}

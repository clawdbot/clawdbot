/** Create a byte-limited stream while retaining direct ownership of the source reader. */
export function createBoundedProviderBinaryStream(
  source: ReadableStream<Uint8Array>,
  options: {
    maxBytes: number;
    createOverflowError: (params: { size: number; maxBytes: number }) => Error;
    createReleaseError: () => Error;
  },
): { stream: ReadableStream<Uint8Array>; release: () => Promise<void> } {
  // Keep direct reader ownership: transform writer rejection can leak when
  // playback cancellation races overflow.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined = source.getReader();
  let cancelPromise: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;
  let pendingError: Error | undefined;
  let totalBytes = 0;

  const releaseReader = (activeReader: ReadableStreamDefaultReader<Uint8Array>) => {
    if (reader !== activeReader) {
      return;
    }
    reader = undefined;
    activeReader.releaseLock();
  };

  const cancelReader = (reason?: unknown): Promise<void> => {
    const activeReader = reader;
    if (!activeReader) {
      return Promise.resolve();
    }
    cancelPromise ??= (async () => {
      try {
        await activeReader.cancel(reason).catch(() => undefined);
      } finally {
        releaseReader(activeReader);
      }
    })();
    return cancelPromise;
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
          await cancelReader(error);
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
      await cancelReader(reason);
    },
  });

  return {
    stream,
    release: () => (releasePromise ??= cancelReader(options.createReleaseError())),
  };
}

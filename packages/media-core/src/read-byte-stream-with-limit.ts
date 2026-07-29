/** Details passed to byte-stream overflow error factories. */
export type ByteStreamLimitOverflow = {
  size: number;
  maxBytes: number;
};

/** Options for reading an async byte stream under a hard byte cap. */
export type ReadByteStreamWithLimitOptions = {
  maxBytes: number;
  onOverflow?: (params: ByteStreamLimitOverflow) => Error;
};

function normalizeByteChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError(`Unsupported byte stream chunk: ${typeof chunk}`);
}

function destroyReadableOnOverflow(stream: unknown, err: Error): void {
  const readable = stream as {
    destroy?: () => unknown;
    cancel?: (reason?: unknown) => unknown;
  };
  // Stop upstream producers immediately after overflow; otherwise large media
  // streams can continue buffering after the caller has already failed.
  if (typeof readable.destroy === "function") {
    try {
      // The helper already throws the overflow error to its caller. Passing the
      // same error to destroy() also emits it on Node streams, which can become
      // an unrelated uncaught exception after the awaited rejection settles.
      readable.destroy();
    } catch {}
    return;
  }
  if (typeof readable.cancel === "function") {
    try {
      void Promise.resolve(readable.cancel(err)).catch(() => undefined);
    } catch {}
  }
}

/** Reads and concatenates an async byte stream, throwing once the byte cap is exceeded. */
export async function readByteStreamWithLimit(
  stream: AsyncIterable<unknown>,
  opts: ReadByteStreamWithLimitOptions,
): Promise<Buffer> {
  const { maxBytes } = opts;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative finite number: ${maxBytes}`);
  }

  const onOverflow =
    opts.onOverflow ??
    ((params: ByteStreamLimitOverflow) =>
      new Error(`Content too large: ${params.size} bytes (limit: ${params.maxBytes} bytes)`));
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    const buffer = normalizeByteChunk(chunk);
    if (buffer.byteLength === 0) {
      continue;
    }
    const nextTotal = total + buffer.byteLength;
    if (nextTotal > maxBytes) {
      const err = onOverflow({ size: nextTotal, maxBytes });
      destroyReadableOnOverflow(stream, err);
      throw err;
    }
    chunks.push(buffer);
    total = nextTotal;
  }

  return Buffer.concat(chunks, total);
}

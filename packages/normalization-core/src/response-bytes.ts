// Byte accounting is shared; callers own decoding, deadlines, and reader cleanup.
export async function consumeResponseBytes(options: {
  maxBytes: number;
  stopAtLimit?: boolean;
  skipEmptyChunks?: boolean;
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  onChunk: (chunk: Uint8Array) => void;
  onLimit: (size: number) => void | Promise<void>;
}): Promise<{ size: number; truncated: boolean }> {
  let size = 0;
  while (true) {
    const { done, value } = await options.read();
    if (done) {
      return { size, truncated: false };
    }
    if (options.skipEmptyChunks !== false && !value?.length) {
      continue;
    }
    const remaining = options.maxBytes - size;
    size += value.length;
    if (size > options.maxBytes || (options.stopAtLimit && size === options.maxBytes)) {
      if (remaining > 0) {
        options.onChunk(value.subarray(0, remaining));
      }
      await options.onLimit(size);
      return { size, truncated: true };
    }
    options.onChunk(value);
  }
}

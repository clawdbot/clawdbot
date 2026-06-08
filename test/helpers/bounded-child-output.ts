export const DEFAULT_CHILD_OUTPUT_TAIL_BYTES = 128 * 1024;

export function createBoundedChildOutput(maxBytes = DEFAULT_CHILD_OUTPUT_TAIL_BYTES) {
  const limit =
    Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_CHILD_OUTPUT_TAIL_BYTES;
  let chunks: Buffer[] = [];
  let totalBytes = 0;

  const trim = () => {
    while (totalBytes > limit && chunks.length > 0) {
      const first = chunks[0];
      if (!first) {
        break;
      }
      const excess = totalBytes - limit;
      if (first.byteLength <= excess) {
        chunks.shift();
        totalBytes -= first.byteLength;
        continue;
      }
      chunks[0] = Buffer.from(first.subarray(excess));
      totalBytes -= excess;
      break;
    }
  };

  return {
    append(chunk: unknown): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (buffer.byteLength >= limit) {
        chunks = [Buffer.from(buffer.subarray(buffer.byteLength - limit))];
        totalBytes = limit;
        return;
      }
      chunks.push(buffer);
      totalBytes += buffer.byteLength;
      trim();
    },
    text(): string {
      return Buffer.concat(chunks, totalBytes).toString("utf8");
    },
  };
}

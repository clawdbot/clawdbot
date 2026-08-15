import { StringDecoder } from "node:string_decoder";

export const DEFAULT_CHILD_OUTPUT_TAIL_BYTES = 128 * 1024;

function decodeUtf8Tail(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length && (buffer[start]! & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return new StringDecoder("utf8").end(buffer.subarray(start));
}

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
      return decodeUtf8Tail(Buffer.concat(chunks, totalBytes));
    },
  };
}

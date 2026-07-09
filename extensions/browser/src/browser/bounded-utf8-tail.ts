/** Byte-bounded UTF-8 tail storage for browser subprocess diagnostics. */
import { StringDecoder } from "node:string_decoder";

function decodeUtf8Tail(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length && (buffer[start]! & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return new StringDecoder("utf8").write(buffer.subarray(start));
}

export function decodeBoundedUtf8Tail(buffer: Buffer, maxBytes: number): string {
  if (maxBytes <= 0 || buffer.length === 0) {
    return "";
  }
  const tail = buffer.length > maxBytes ? buffer.subarray(buffer.length - maxBytes) : buffer;
  return decodeUtf8Tail(tail);
}

export function createBoundedUtf8Tail(maxBytes: number) {
  const storage = Buffer.allocUnsafe(Math.max(0, maxBytes));
  let totalBytes = 0;

  return {
    append(chunk: Buffer | string) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length === 0 || maxBytes <= 0) {
        return;
      }
      if (buffer.length >= maxBytes) {
        buffer.copy(storage, 0, buffer.length - maxBytes);
        totalBytes = maxBytes;
        return;
      }

      const overflowBytes = Math.max(0, totalBytes + buffer.length - maxBytes);
      if (overflowBytes > 0) {
        storage.copyWithin(0, overflowBytes, totalBytes);
        totalBytes -= overflowBytes;
      }
      buffer.copy(storage, totalBytes);
      totalBytes += buffer.length;
    },
    text() {
      return decodeUtf8Tail(storage.subarray(0, totalBytes));
    },
    clear() {
      totalBytes = 0;
    },
  };
}

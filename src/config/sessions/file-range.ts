// Session file helpers share bounded random-access reads across transcript consumers.
import type { FileHandle } from "node:fs/promises";

export async function readFileRangeAsync(
  fileHandle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await fileHandle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) {
      break;
    }
    offset += bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

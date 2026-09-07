import { createHash } from "node:crypto";
import { readSync, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export type FileMutationFingerprint = Pick<
  BigIntStats,
  "birthtimeNs" | "ctimeNs" | "dev" | "ino" | "mtimeNs" | "size"
>;

/** Strict field equality; callers own any platform-specific identity tolerance. */
export function sameFileMutationFingerprint(
  left: FileMutationFingerprint,
  right: FileMutationFingerprint,
): boolean {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  );
}

/** Hashes from offset zero without moving or closing the caller's descriptor. */
export function hashFileDescriptorSync(fd: number): { sha256: string; sizeBytes: number } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      break;
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { sha256: hash.digest("hex"), sizeBytes: position };
}

/** Copies pinned handles; their owner retains mutation checks, sync, and publication. */
export async function copyFileHandle(
  source: FileHandle,
  target: FileHandle,
  options: { noProgressMessage: string; onChunk?: (chunk: Uint8Array) => void },
): Promise<number> {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) {
      return offset;
    }
    // A source digest must observe the bytes before any awaited target write.
    options.onChunk?.(buffer.subarray(0, bytesRead));
    let bytesWritten = 0;
    while (bytesWritten < bytesRead) {
      const result = await target.write(
        buffer,
        bytesWritten,
        bytesRead - bytesWritten,
        offset + bytesWritten,
      );
      if (result.bytesWritten === 0) {
        throw new Error(options.noProgressMessage);
      }
      bytesWritten += result.bytesWritten;
    }
    offset += bytesRead;
  }
}

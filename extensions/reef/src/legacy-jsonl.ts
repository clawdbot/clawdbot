import fs from "node:fs/promises";

const REEF_LEGACY_JSONL_RECORD_MAX_BYTES = 32 * 1024 * 1024;
const REEF_LEGACY_JSONL_READ_CHUNK_BYTES = 64 * 1024;

// Migration must validate the complete legacy journal before archiving it or
// making imported state authoritative. Stream records so file size cannot
// become the memory bound; callers own their canonical retention windows.
export async function forEachLegacyReefJsonlRecord(
  filePath: string,
  finalRecord: "reject-torn" | "ignore-torn",
  visit: (value: unknown, recordBytes: number) => void | Promise<void>,
): Promise<void> {
  const handle = await fs.open(filePath, "r");
  let pendingChunks: Buffer[] = [];
  let pendingBytes = 0;
  let position = 0;
  try {
    while (true) {
      const buffer = Buffer.alloc(REEF_LEGACY_JSONL_READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        REEF_LEGACY_JSONL_READ_CHUNK_BYTES,
        position,
      );
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      const chunk = bytesRead < buffer.length ? buffer.subarray(0, bytesRead) : buffer;
      let lineStart = 0;
      for (let newlineIndex = chunk.indexOf(0x0a); newlineIndex !== -1;) {
        const segment = chunk.subarray(lineStart, newlineIndex);
        const recordBytes = pendingBytes + segment.length;
        if (recordBytes > REEF_LEGACY_JSONL_RECORD_MAX_BYTES) {
          throw new Error(
            `Reef legacy JSONL record exceeds ${REEF_LEGACY_JSONL_RECORD_MAX_BYTES} bytes`,
          );
        }
        if (recordBytes > 0) {
          const line =
            pendingChunks.length === 0
              ? segment
              : Buffer.concat([...pendingChunks, segment], recordBytes);
          await visit(JSON.parse(line.toString("utf8")) as unknown, recordBytes);
        }
        pendingChunks = [];
        pendingBytes = 0;
        lineStart = newlineIndex + 1;
        newlineIndex = chunk.indexOf(0x0a, lineStart);
      }
      const remainder = chunk.subarray(lineStart);
      if (remainder.length > 0) {
        pendingChunks.push(remainder);
        pendingBytes += remainder.length;
      }
      if (pendingBytes > REEF_LEGACY_JSONL_RECORD_MAX_BYTES) {
        throw new Error(
          `Reef legacy JSONL record exceeds ${REEF_LEGACY_JSONL_RECORD_MAX_BYTES} bytes`,
        );
      }
    }
  } finally {
    await handle.close();
  }
  if (pendingBytes === 0) {
    return;
  }
  const pending =
    pendingChunks.length === 1 ? pendingChunks[0]! : Buffer.concat(pendingChunks, pendingBytes);
  try {
    const value = JSON.parse(pending.toString("utf8")) as unknown;
    await visit(value, pendingBytes);
  } catch (error) {
    if (finalRecord === "reject-torn") {
      throw error;
    }
    // Preserve the legacy replay migration behavior: any invalid final
    // unterminated record is treated as a torn append and dropped.
  }
}

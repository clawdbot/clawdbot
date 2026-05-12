import fs from "node:fs";
import readline from "node:readline";

// Shared streaming helpers for JSONL session transcripts.
//
// Callers historically read the entire transcript with `fs.readFile` before
// splitting on newlines. That worked fine for short sessions but produced real
// memory pressure on long-running ones where transcripts grow to tens or
// hundreds of MB (see #54296). These helpers replace the whole-file reads with
// either a forward `readline` stream or a chunked reverse scan. Both are bounded
// to a small chunk plus the current line and preserve the malformed-line
// tolerance and "first/last match wins" semantics callers rely on.

const DEFAULT_REVERSE_CHUNK_BYTES = 64 * 1024;
const MAX_REVERSE_CHUNK_BYTES = 1024 * 1024;
const MIN_REVERSE_CHUNK_BYTES = 1024;

export type TranscriptStreamOptions = {
  signal?: AbortSignal;
};

export type TranscriptReverseStreamOptions = TranscriptStreamOptions & {
  /** Bytes read per reverse scan chunk. Clamped to [1KiB, 1MiB]. */
  chunkBytes?: number;
};

/**
 * Stream the non-empty, trimmed JSONL lines of a transcript file in order.
 *
 * Returns an empty async iterator if the file does not exist, is empty, or is
 * not a regular file. Honours `options.signal` between lines so long scans can
 * cooperate with abort signals.
 */
export async function* streamSessionTranscriptLines(
  filePath: string,
  options: TranscriptStreamOptions = {},
): AsyncGenerator<string> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size <= 0) {
    return;
  }
  if (options.signal?.aborted) {
    return;
  }
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (options.signal?.aborted) {
        return;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      yield trimmed;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Stream the non-empty, trimmed JSONL lines of a transcript file in reverse
 * (newest-first) order.
 *
 * Returns an empty async iterator if the file cannot be opened, is empty, or is
 * not a regular file. The implementation splits on newline bytes before UTF-8
 * decoding so multibyte characters survive arbitrary chunk boundaries.
 */
export async function* streamSessionTranscriptLinesReverse(
  filePath: string,
  options: TranscriptReverseStreamOptions = {},
): AsyncGenerator<string> {
  const requestedChunkBytes = Number.isFinite(options.chunkBytes)
    ? Math.max(MIN_REVERSE_CHUNK_BYTES, Math.floor(options.chunkBytes as number))
    : DEFAULT_REVERSE_CHUNK_BYTES;
  const chunkBytes = Math.min(requestedChunkBytes, MAX_REVERSE_CHUNK_BYTES);

  let fileHandle: Awaited<ReturnType<typeof fs.promises.open>>;
  try {
    fileHandle = await fs.promises.open(filePath, "r");
  } catch {
    return;
  }
  try {
    const stat = await fileHandle.stat();
    if (!stat.isFile() || stat.size <= 0 || options.signal?.aborted) {
      return;
    }

    let position = stat.size;
    let carry: Buffer = Buffer.alloc(0);
    while (position > 0) {
      if (options.signal?.aborted) {
        return;
      }
      const readLength = Math.min(position, chunkBytes);
      position -= readLength;
      const chunk = await readFileRangeAsync(fileHandle, position, readLength);
      const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let lineEnd = combined.length;
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== 0x0a) {
          continue;
        }
        const line = decodeTrimmedLine(combined.subarray(index + 1, lineEnd));
        if (line) {
          yield line;
          if (options.signal?.aborted) {
            return;
          }
        }
        lineEnd = index;
      }
      carry = combined.subarray(0, lineEnd);
    }

    const firstLine = decodeTrimmedLine(carry);
    if (firstLine && !options.signal?.aborted) {
      yield firstLine;
    }
  } finally {
    await fileHandle.close().catch(() => undefined);
  }
}

function decodeTrimmedLine(line: Buffer): string {
  const trimmed = line.toString("utf-8").trim();
  return trimmed;
}

async function readFileRangeAsync(
  fileHandle: Awaited<ReturnType<typeof fs.promises.open>>,
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

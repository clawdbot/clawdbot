import fs from "node:fs/promises";

const JSONL_STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;
const JSONL_READ_CHUNK_BYTES = 1024 * 1024;
export const JSONL_FIRST_LINE_CHUNK_BYTES = 64 * 1024;

export async function visitJsonlLines(
  file: string,
  visitor: (line: string) => boolean | void,
  chunkBytes = JSONL_READ_CHUNK_BYTES,
): Promise<{ ok: boolean; lineCount: number }> {
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return { ok: false, lineCount: 0 };
  }
  if (size <= JSONL_STREAM_THRESHOLD_BYTES) {
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      return { ok: false, lineCount: 0 };
    }
    if (content.length === 0) {
      return { ok: true, lineCount: 0 };
    }
    let lineCount = 0;
    for (const line of content.split(/\r?\n/u)) {
      lineCount += 1;
      if (visitor(line) === false) {
        break;
      }
    }
    return { ok: true, lineCount };
  }

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return { ok: false, lineCount: 0 };
  }
  const buffer = Buffer.allocUnsafe(chunkBytes);
  const decoder = new TextDecoder();
  let pendingFragments: string[] = [];
  let lineCount = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      const content = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      let lineStart = 0;
      while (true) {
        const newline = content.indexOf("\n", lineStart);
        if (newline === -1) {
          break;
        }
        let rawLine = content.slice(lineStart, newline);
        if (pendingFragments.length > 0) {
          pendingFragments.push(rawLine);
          rawLine = pendingFragments.join("");
          pendingFragments = [];
        }
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        lineCount += 1;
        if (visitor(line) === false) {
          return { ok: true, lineCount };
        }
        lineStart = newline + 1;
      }
      if (lineStart < content.length) {
        pendingFragments.push(content.slice(lineStart));
      }
    }
    const decoderTail = decoder.decode();
    if (decoderTail.length > 0) {
      pendingFragments.push(decoderTail);
    }
    if (pendingFragments.length > 0) {
      const rawLine = pendingFragments.join("");
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      lineCount += 1;
      visitor(line);
    }
    return { ok: true, lineCount };
  } catch {
    return { ok: false, lineCount: 0 };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

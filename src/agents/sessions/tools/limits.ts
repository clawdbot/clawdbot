export function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

export const SESSION_TOOL_STDERR_TAIL_BYTES = 64 * 1024;

function decodeUtf8TextTail(buffer: Buffer, maxBytes: number): string {
  const chars = Array.from(buffer.toString("utf8"));
  const kept: string[] = [];
  let bytes = 0;

  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i] ?? "";
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }
    kept.push(char);
    bytes += charBytes;
  }

  return kept.toReversed().join("");
}

export function appendBoundedTextTail(
  current: string,
  chunk: Buffer | string,
  maxBytes = SESSION_TOOL_STDERR_TAIL_BYTES,
): string {
  const effectiveMaxBytes = normalizePositiveLimit(maxBytes, SESSION_TOOL_STDERR_TAIL_BYTES);
  const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (chunkBuffer.byteLength >= effectiveMaxBytes) {
    return decodeUtf8TextTail(chunkBuffer, effectiveMaxBytes);
  }

  const currentBuffer = Buffer.from(current);
  const nextBytes = currentBuffer.byteLength + chunkBuffer.byteLength;
  if (nextBytes <= effectiveMaxBytes) {
    return `${current}${chunkBuffer.toString("utf8")}`;
  }

  const currentTailBytes = Math.max(0, effectiveMaxBytes - chunkBuffer.byteLength);
  const currentTail = currentBuffer.subarray(currentBuffer.byteLength - currentTailBytes);
  return decodeUtf8TextTail(Buffer.concat([currentTail, chunkBuffer]), effectiveMaxBytes);
}

import type { EmbeddingInput } from "./embedding-inputs.js";

// Helpers for enforcing embedding model input size limits.
//
// We use UTF-8 byte length as a conservative upper bound for tokenizer output.
// Tokenizers operate over bytes; a token must contain at least one byte, so
// token_count <= utf8_byte_length.

export function estimateUtf8Bytes(text: string): number {
  if (!text) {
    return 0;
  }
  return Buffer.byteLength(text, "utf8");
}

export function estimateStructuredEmbeddingInputBytes(input: EmbeddingInput): number {
  if (!input.parts?.length) {
    return estimateUtf8Bytes(input.text);
  }
  let total = 0;
  for (const part of input.parts) {
    if (part.type === "text") {
      total += estimateUtf8Bytes(part.text);
      continue;
    }
    total += estimateUtf8Bytes(part.mimeType);
    total += estimateUtf8Bytes(part.data);
  }
  return total;
}

export function splitTextToUtf8ByteLimit(text: string, maxUtf8Bytes: number): string[] {
  if (maxUtf8Bytes <= 0) {
    return [text];
  }
  if (estimateUtf8Bytes(text) <= maxUtf8Bytes) {
    return [text];
  }

  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    // The number of UTF-16 code units is always <= the number of UTF-8 bytes.
    // This makes `cursor + maxUtf8Bytes` a safe upper bound on the next split point.
    let low = cursor + 1;
    let high = Math.min(text.length, cursor + maxUtf8Bytes);
    let best = cursor;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const bytes = estimateUtf8Bytes(text.slice(cursor, mid));
      if (bytes <= maxUtf8Bytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (best <= cursor) {
      best = Math.min(text.length, cursor + 1);
    }

    // Avoid splitting inside a surrogate pair.
    if (
      best < text.length &&
      best > cursor &&
      text.charCodeAt(best - 1) >= 0xd800 &&
      text.charCodeAt(best - 1) <= 0xdbff &&
      text.charCodeAt(best) >= 0xdc00 &&
      text.charCodeAt(best) <= 0xdfff
    ) {
      best -= 1;
    }

    const part = text.slice(cursor, best);
    if (!part) {
      break;
    }
    parts.push(part);
    cursor = best;
  }

  return parts;
}

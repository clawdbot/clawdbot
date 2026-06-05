// Markdown Core module implements chunk text behavior.
function resolveChunkEarlyReturn(text: string, limit: number): string[] | undefined {
  if (!text) {
    return [];
  }
  if (limit <= 0) {
    return [text];
  }
  if (text.length <= limit) {
    return [text];
  }
  return undefined;
}

function scanParenAwareBreakpoints(text: string): { lastNewline: number; lastWhitespace: number } {
  let lastNewline = -1;
  let lastWhitespace = -1;
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    // Parenthesized spans often contain rewritten links or file references;
    // avoid splitting them unless the window has no safer outside break.
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (char === "\n") {
      lastNewline = i;
    } else if (/\s/.test(char)) {
      lastWhitespace = i;
    }
  }

  return { lastNewline, lastWhitespace };
}

/**
 * Splits plain text into size-bounded chunks at readable boundaries.
 *
 * Returns the original text as one chunk when the limit is non-positive.
 */
export function chunkText(text: string, limit: number): string[] {
  const early = resolveChunkEarlyReturn(text, limit);
  if (early) {
    return early;
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text.length - cursor <= limit) {
      chunks.push(text.slice(cursor));
      break;
    }
    const windowEnd = Math.min(text.length, cursor + limit);
    const window = text.slice(cursor, windowEnd);
    const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window);
    // Prefer block boundaries, then spaces, then a hard size cut when no
    // readable breakpoint exists inside this window.
    const breakOffset = lastNewline > 0 ? lastNewline : lastWhitespace;
    const end = breakOffset > 0 ? cursor + breakOffset : windowEnd;
    chunks.push(text.slice(cursor, end));
    cursor = end;
    while (cursor < text.length && /\s/.test(text[cursor] ?? "")) {
      cursor += 1;
    }
  }
  return chunks;
}

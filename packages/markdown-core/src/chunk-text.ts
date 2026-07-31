// Markdown Core module implements chunk text behavior.
import { avoidTrailingHighSurrogateBreak } from "@openclaw/normalization-core/utf16-slice";

export { avoidTrailingHighSurrogateBreak };

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
    const char = text.charAt(i);
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

export type TextChunkRange = {
  start: number;
  end: number;
};

export type ChunkTextRangesOptions = {
  limit: number;
  mode?: "hard" | "preferred";
};

function findPreferredRangeEnd(text: string, start: number, end: number): number | undefined {
  const slice = text.slice(start, end);
  let paragraphEnd: number | undefined;
  for (const match of slice.matchAll(/\n[\t ]*\n+/g)) {
    if (match.index !== undefined) {
      paragraphEnd = start + match.index + match[0].length;
    }
  }
  if (paragraphEnd !== undefined) {
    return paragraphEnd;
  }

  const newlineIndex = text.lastIndexOf("\n", end - 1);
  if (newlineIndex >= start) {
    return newlineIndex + 1;
  }

  for (let index = end - 1; index > start; index -= 1) {
    if (/\s/.test(text.charAt(index))) {
      return index + 1;
    }
  }
  return undefined;
}

/**
 * Splits text into contiguous UTF-16 ranges without dropping separator whitespace.
 * Preferred mode selects paragraph, newline, then whitespace boundaries.
 */
export function chunkTextRanges(text: string, options: ChunkTextRangesOptions): TextChunkRange[] {
  if (!text) {
    return [];
  }
  if (options.limit <= 0 || text.length <= options.limit) {
    return [{ start: 0, end: text.length }];
  }

  const ranges: TextChunkRange[] = [];
  let start = 0;
  while (start < text.length) {
    const maxEnd = Math.min(text.length, start + options.limit);
    const preferredEnd =
      options.mode === "preferred" && maxEnd < text.length
        ? findPreferredRangeEnd(text, start, maxEnd)
        : undefined;
    const candidateEnd = preferredEnd && preferredEnd > start ? preferredEnd : maxEnd;
    const end = avoidTrailingHighSurrogateBreak(text, start, candidateEnd);
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
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
    const end = avoidTrailingHighSurrogateBreak(
      text,
      cursor,
      breakOffset > 0 ? cursor + breakOffset : windowEnd,
    );
    chunks.push(text.slice(cursor, end));
    cursor = end;
    while (cursor < text.length && /\s/.test(text[cursor] ?? "")) {
      cursor += 1;
    }
  }
  return chunks;
}

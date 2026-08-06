import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { avoidTrailingHighSurrogateBreak } from "@openclaw/normalization-core/utf16-slice";

export { avoidTrailingHighSurrogateBreak };

const CJK_PUNCTUATION_BREAK_AFTER_RE = /[、。，．！？；：）］｝〉》」』】〕〗〙]/u;

function normalizeChunkLimit(limit: number): number {
  // String slicing truncates fractional indexes, so positive limits need an integer progress step.
  return Number.isFinite(limit) && limit > 0 ? resolveIntegerOption(limit, 1, { min: 1 }) : limit;
}

function clampToCodePointBoundary(text: string, index: number): number {
  const boundary = Math.min(Math.max(0, index), text.length);
  return avoidTrailingHighSurrogateBreak(text, 0, boundary);
}

function findWhitespaceBreak(window: string): number {
  for (let index = window.length - 1; index >= 0; index--) {
    if (/\s/.test(window.charAt(index))) {
      return index;
    }
  }
  return -1;
}

function findCjkPunctuationBreak(window: string): number {
  for (let end = window.length; end > 0;) {
    const code = window.charCodeAt(end - 1);
    const start = code >= 0xdc00 && code <= 0xdfff && end > 1 ? end - 2 : end - 1;
    if (start > 0 && CJK_PUNCTUATION_BREAK_AFTER_RE.test(window.slice(start, end))) {
      return end;
    }
    end = start;
  }
  return -1;
}

export function splitLongTextLine(
  line: string,
  limit: number,
  options: { preserveWhitespace: boolean },
): string[] {
  const normalizedLimit = normalizeChunkLimit(limit);
  if (normalizedLimit <= 0 || line.length <= normalizedLimit) {
    return [line];
  }
  const chunks: string[] = [];
  let remaining = line;
  while (remaining.length > normalizedLimit) {
    let breakIndex = clampToCodePointBoundary(remaining, normalizedLimit);
    if (!options.preserveWhitespace) {
      const window = remaining.slice(0, normalizedLimit);
      breakIndex = findWhitespaceBreak(window);
      if (breakIndex <= 0) {
        breakIndex = findCjkPunctuationBreak(window);
      }
      if (breakIndex <= 0) {
        breakIndex = clampToCodePointBoundary(remaining, normalizedLimit);
      }
    }
    chunks.push(remaining.slice(0, breakIndex));
    remaining = remaining.slice(breakIndex);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

/**
 * Splits text into bounded chunks using caller-owned soft-break selection.
 *
 * The resolver sees each limit-sized window and returns an in-window break index;
 * invalid indexes fall back to the hard limit so chunking always makes progress.
 */
export function chunkTextByBreakResolver(
  text: string,
  limit: number,
  resolveBreakIndex: (window: string) => number,
): string[] {
  if (!text) {
    return [];
  }
  const normalizedLimit = normalizeChunkLimit(limit);
  if (normalizedLimit <= 0 || text.length <= normalizedLimit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > normalizedLimit) {
    const window = remaining.slice(0, normalizedLimit);
    const candidateBreak = resolveBreakIndex(window);
    // Invalid, fractional, or zero-width soft breaks would stall the loop.
    const breakIdx =
      Number.isInteger(candidateBreak) && candidateBreak > 0 && candidateBreak <= normalizedLimit
        ? candidateBreak
        : normalizedLimit;
    const safeBreakIdx = avoidTrailingHighSurrogateBreak(remaining, 0, breakIdx);
    const rawChunk = remaining.slice(0, safeBreakIdx);
    const chunk = rawChunk.trimEnd();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    // Keep separator ownership with the boundary: one matched separator is
    // consumed here, and any adjacent whitespace is trimmed before the next window.
    const brokeOnSeparator =
      safeBreakIdx < remaining.length && /\s/.test(remaining.charAt(safeBreakIdx));
    const nextStart = Math.min(remaining.length, safeBreakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }
  const finalChunk = remaining.trimEnd();
  if (finalChunk.length) {
    chunks.push(finalChunk);
  }
  return chunks;
}

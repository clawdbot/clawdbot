/**
 * Splits text into bounded chunks using caller-owned soft-break selection.
 *
 * The resolver sees each limit-sized window and returns an in-window break index;
 * invalid indexes fall back to the hard limit so chunking always makes progress.
 */
export function avoidTrailingHighSurrogateBreak(text: string, start: number, end: number): number {
  if (end <= start || end >= text.length) {
    return end;
  }
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  const splitsSurrogatePair =
    previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  if (!splitsSurrogatePair) {
    return end;
  }
  const adjusted = end - 1;
  return adjusted > start ? adjusted : end + 1;
}

export function chunkTextByBreakResolver(
  text: string,
  limit: number,
  resolveBreakIndex: (window: string) => number,
): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const candidateBreak = resolveBreakIndex(window);
    // Invalid or zero-width soft breaks would stall the loop, so fall back to the hard limit.
    const breakIdx =
      Number.isFinite(candidateBreak) && candidateBreak > 0 && candidateBreak <= limit
        ? candidateBreak
        : limit;
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
  if (remaining.length) {
    chunks.push(remaining);
  }
  return chunks;
}

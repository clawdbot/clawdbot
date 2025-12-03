// Utilities for splitting outbound text into platform-sized chunks without
// unintentionally breaking on newlines. Using [\s\S] keeps newlines inside
// the chunk so messages are only split when they truly exceed the limit.

export function chunkText(text: string, limit: number): string[] {
  if (!text) return [];
  if (limit <= 0) return [text];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);

    // 1) Prefer a newline break inside the window.
    let breakIdx = window.lastIndexOf("\n");

    // 2) Otherwise prefer the last whitespace (word boundary) inside the window.
    if (breakIdx <= 0) {
      for (let i = window.length - 1; i >= 0; i--) {
        if (/\s/.test(window[i])) {
          breakIdx = i;
          break;
        }
      }
    }

    // 3) Fallback: hard break exactly at the limit.
    if (breakIdx <= 0) breakIdx = limit;

    const rawChunk = remaining.slice(0, breakIdx);
    const chunk = rawChunk.trimEnd();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    // If we broke on whitespace/newline, skip that separator; for hard breaks keep it.
    const brokeOnSeparator =
      breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(
      remaining.length,
      breakIdx + (brokeOnSeparator ? 1 : 0),
    );
    remaining = remaining.slice(nextStart).trimStart();
  }

  if (remaining.length) chunks.push(remaining);

  return chunks;
}

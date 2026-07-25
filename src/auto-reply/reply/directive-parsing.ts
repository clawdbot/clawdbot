/** Low-level token scanning helpers for inline directive parsers. */
export function skipDirectiveArgPrefix(raw: string): number {
  let i = 0;
  const len = raw.length;
  while (i < len && /\s/.test(raw.charAt(i))) {
    i += 1;
  }
  if (raw[i] === ":") {
    i += 1;
    while (i < len && /\s/.test(raw.charAt(i))) {
      i += 1;
    }
  }
  return i;
}

/** Reads the next non-whitespace directive token and returns the next scan index. */
export function takeDirectiveToken(
  raw: string,
  startIndex: number,
): { token: string | null; nextIndex: number } {
  let i = startIndex;
  const len = raw.length;
  while (i < len && /\s/.test(raw.charAt(i))) {
    i += 1;
  }
  if (i >= len) {
    return { token: null, nextIndex: i };
  }
  const start = i;
  while (i < len && !/\s/.test(raw.charAt(i))) {
    i += 1;
  }
  if (start === i) {
    return { token: null, nextIndex: i };
  }
  const token = raw.slice(start, i);
  while (i < len && /\s/.test(raw.charAt(i))) {
    i += 1;
  }
  return { token, nextIndex: i };
}

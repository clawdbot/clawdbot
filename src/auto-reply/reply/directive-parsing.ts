/** Remove a recognized span without rewriting unrelated prompt bytes. */
export function removeDirectiveSpan(body: string, start: number, end: number): string {
  let removalStart = start;
  let removalEnd = end;
  const lineStart = body.lastIndexOf("\n", start - 1) + 1;
  const beforeOnLine = body.slice(lineStart, start);
  const lineEnding = /^[ \t]*(?:\r?\n|$)/.exec(body.slice(end));
  // A directive-only line owns its line ending, never the next line's indentation.
  // Inline directives own at most one separator; the remaining spacing is user text.
  if (/^[ \t]*$/.test(beforeOnLine) && lineEnding) {
    removalStart = lineStart;
    removalEnd += lineEnding[0].length;
  } else if (/[ \t]/.test(body.charAt(end))) {
    removalEnd += 1;
  } else if (
    (end === body.length || /[\r\n]/.test(body.charAt(end))) &&
    /\S/.test(beforeOnLine) &&
    /[ \t]/.test(body.charAt(start - 1))
  ) {
    removalStart -= 1;
  }
  const cleaned = body.slice(0, removalStart) + body.slice(removalEnd);
  return cleaned.trim() ? cleaned : "";
}

/** Only a colon commits an argument prefix; whitespace belongs to the next accepted token. */
export function skipDirectiveArgPrefix(raw: string): number {
  return /^\s*:/.exec(raw)?.[0].length ?? 0;
}

/** Stops at the token end; following whitespace is consumed only with another accepted token. */
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
  const token = raw.slice(start, i);
  return { token, nextIndex: i };
}

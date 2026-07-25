// Surrogate-safe UTF-16 string slicing helpers.
//
// Kept dependency-free (no node: imports) so browser/UI bundles can import them
// without dragging in filesystem/runtime code. See utils.ts, which re-exports
// these for the broad runtime surface.

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** Moves a chunk boundary away from the middle of a UTF-16 surrogate pair. */
export function avoidTrailingHighSurrogateBreak(text: string, start: number, end: number): number {
  if (
    end <= start ||
    end >= text.length ||
    !isHighSurrogate(text.charCodeAt(end - 1)) ||
    !isLowSurrogate(text.charCodeAt(end))
  ) {
    return end;
  }
  const adjusted = end - 1;
  return adjusted > start ? adjusted : end + 1;
}

/** Slices a UTF-16 string without returning dangling surrogate halves at either edge. */
export function sliceUtf16Safe(input: string, start: number, end?: number): string {
  const len = input.length;

  let from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let to = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);

  if (to <= from) {
    return "";
  }

  if (from > 0 && from < len) {
    const codeUnit = input.charCodeAt(from);
    if (isLowSurrogate(codeUnit) && isHighSurrogate(input.charCodeAt(from - 1))) {
      from += 1;
    }
  }

  if (to > 0 && to < len) {
    const codeUnit = input.charCodeAt(to - 1);
    if (isHighSurrogate(codeUnit) && isLowSurrogate(input.charCodeAt(to))) {
      to -= 1;
    }
  }

  return input.slice(from, to);
}

/** Truncates a UTF-16 string without cutting a surrogate pair in half. */
export function truncateUtf16Safe(input: string, maxLen: number): string {
  const limit = Math.max(0, Math.floor(maxLen));
  if (input.length <= limit) {
    return input;
  }
  return sliceUtf16Safe(input, 0, limit);
}

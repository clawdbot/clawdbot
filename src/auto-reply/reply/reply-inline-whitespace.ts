// Normalizes inline directive whitespace without changing user-visible text.
const INLINE_HORIZONTAL_WHITESPACE_RE = /[^\S\n]+/g;

/** Collapses horizontal inline whitespace while preserving line breaks. */
export function collapseInlineHorizontalWhitespace(value: string): string {
  return value.replace(INLINE_HORIZONTAL_WHITESPACE_RE, " ");
}

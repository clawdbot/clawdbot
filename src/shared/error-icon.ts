/** Canonical error-presentation icon sanitization (node-safe, no I/O). */

// Matches one or more leading warning icons with optional trailing whitespace.
// Covers repeated prefixes like "⚠️ ⚠️ " or "⚠️⚠️  " without stripping mid-string icons.
const ERROR_ICON_PREFIX_RE = /^(?:⚠️\s*)+/u;

/** Strip any leading warning-icon prefix (including repeated) from text. */
export function stripErrorIconPrefix(text: string): string {
  return text.replace(ERROR_ICON_PREFIX_RE, "");
}

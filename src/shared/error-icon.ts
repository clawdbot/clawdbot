/** Canonical error-presentation icon sanitization (node-safe, no I/O). */

export const ERROR_ICON = "⚠️";

// Matches one or more leading warning icons with optional trailing whitespace.
// Covers repeated prefixes like "⚠️ ⚠️ " or "⚠️⚠️  " without stripping mid-string icons.
export const ERROR_ICON_PREFIX_RE = /^(?:⚠️\s*)+/u;

// Token match for a single warning icon; useful for presence checks.
export const ERROR_ICON_PREFIX_TOKEN_RE = /⚠️/u;

/** Strip any leading warning-icon prefix (including repeated) from text. */
export function stripErrorIconPrefix(text: string): string {
  return text.replace(ERROR_ICON_PREFIX_RE, "");
}

/**
 * Format raw error text for Web-UI/user-facing presentation.
 * Keeps raw message storage untouched; callers should store raw and format only when rendering.
 * Strips repeated leading icons, normalizes whitespace outside, and ensures a single leading icon when text remains.
 * For cases that only need stripping (e.g. embedding inside a larger prefix), prefer stripErrorIconPrefix.
 */
export function formatWebUiIconErrorText(text: string): string {
  const stripped = stripErrorIconPrefix(text.trim()).replace(/\s+/gu, " ").trim();
  if (!stripped) {
    return "";
  }
  return `${ERROR_ICON} ${stripped}`;
}

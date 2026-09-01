/** Canonical error-presentation icon sanitization. */

export const ERROR_ICON_PREFIX_RE = /^(?:⚠️\s*)+/u;

export function stripErrorIconPrefix(text: string): string {
  return text.replace(ERROR_ICON_PREFIX_RE, "");
}

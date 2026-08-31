export const ERROR_ICON_TOKEN = "⚠️";

export const ERROR_ICON_PREFIX_RE = /^(?:\u26A0\uFE0F*\s*)+/u;

export const ERROR_TEXT_PREFIX_RE = /^(?:Error:\s*)+/iu;

// Combined prefix stripping for comparison: handles interleaved repeated
// icon and text prefixes like "⚠️ Error: ⚠️ Error: foo" and variation
// selector forms like "⚠️\uFE0F hello".
function stripErrorPrefix(text: string): string {
  let previous: string;
  let next = text;
  do {
    previous = next;
    next = next.replace(ERROR_ICON_PREFIX_RE, "").replace(ERROR_TEXT_PREFIX_RE, "");
  } while (next !== previous);
  return next;
}

export function formatWebUiIconErrorText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return ERROR_ICON_TOKEN;
  }
  const stripped = stripErrorPrefix(trimmed);
  if (ERROR_ICON_PREFIX_RE.test(trimmed)) {
    // Normalized icon form ensures single token prefix.
    return `${ERROR_ICON_TOKEN} ${stripped || trimmed.replace(ERROR_ICON_PREFIX_RE, "").trim() || trimmed}`;
  }
  return `${ERROR_ICON_TOKEN} ${stripped || trimmed}`;
}

export function normalizeErrorComparisonText(text: string): string {
  // Allow leading whitespace before icon/text prefixes for robust
  // comparison (e.g. "  ⚠️  Error: foo" -> "foo").
  let normalized = text.trimStart();
  normalized = stripErrorPrefix(normalized);
  // After stripping one prefix, the remaining may start with whitespace
  // before the next prefix (e.g. interleaved forms). Loop handles it
  // but stripErrorPrefix already loops; collapse whitespace for comparison.
  return normalized.replace(/\s+/gu, " ").trim();
}

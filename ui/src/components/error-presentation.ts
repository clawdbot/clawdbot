export const ERROR_ICON_TOKEN = "⚠️";

export const ERROR_ICON_PREFIX_RE = /^(?:\u26A0\uFE0F*\s*)+/u;

export const ERROR_ICON_PREFIX_TOKEN_RE = /\u26A0\uFE0F*/gu;

export const ERROR_TEXT_PREFIX_RE = /^(?:Error:\s*)+/iu;

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
    return `${ERROR_ICON_TOKEN} ${stripped || trimmed.replace(ERROR_ICON_PREFIX_RE, "").trim() || trimmed}`;
  }
  return `${ERROR_ICON_TOKEN} ${stripped || trimmed}`;
}

export function stripErrorIconPrefix(text: string): string {
  return text.replace(ERROR_ICON_PREFIX_RE, "");
}

export function normalizeErrorComparisonText(text: string): string {
  let normalized = text.trimStart();
  normalized = stripErrorPrefix(normalized);
  return normalized.replace(/\s+/gu, " ").trim();
}

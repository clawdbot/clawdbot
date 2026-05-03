const CSS_WIDTH_KEYWORDS = new Set(["none", "min-content", "max-content"]);
const CSS_WIDTH_FUNCTIONS = new Set(["calc", "clamp", "fit-content", "max", "min"]);
const CSS_WIDTH_UNITS = new Set(["ch", "em", "rem", "vh", "vmax", "vmin", "vw", "px"]);
const CSS_WIDTH_ALLOWED_CHARS = /^[0-9A-Za-z.%+\-*/(),\s]+$/;
const CSS_WIDTH_IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9-]*/g;
const CSS_WIDTH_SIMPLE_RE = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|ch|vw|vh|vmin|vmax|%)$/i;
const CSS_WIDTH_MAX_LENGTH = 96;

function hasBalancedParentheses(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

function hasAllowedIdentifiers(value: string): boolean {
  for (const match of value.matchAll(CSS_WIDTH_IDENTIFIER_RE)) {
    const identifier = match[0].toLowerCase();
    if (
      !CSS_WIDTH_FUNCTIONS.has(identifier) &&
      !CSS_WIDTH_KEYWORDS.has(identifier) &&
      !CSS_WIDTH_UNITS.has(identifier)
    ) {
      return false;
    }
  }
  return true;
}

export function normalizeControlUiChatMessageMaxWidth(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isValidControlUiChatMessageMaxWidth(value: string): boolean {
  const normalized = normalizeControlUiChatMessageMaxWidth(value);
  if (normalized.length === 0 || normalized.length > CSS_WIDTH_MAX_LENGTH) {
    return false;
  }
  if (CSS_WIDTH_KEYWORDS.has(normalized.toLowerCase())) {
    return true;
  }
  if (CSS_WIDTH_SIMPLE_RE.test(normalized)) {
    return true;
  }
  if (!CSS_WIDTH_ALLOWED_CHARS.test(normalized)) {
    return false;
  }
  if (!hasBalancedParentheses(normalized) || !hasAllowedIdentifiers(normalized)) {
    return false;
  }
  return /^(?:calc|clamp|fit-content|max|min)\(.+\)$/i.test(normalized);
}

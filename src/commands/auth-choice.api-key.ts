const DEFAULT_KEY_PREVIEW = { head: 4, tail: 4 };

export function normalizeApiKeyInput(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";

  // Handle shell-style assignments: export KEY="value" or KEY=value
  const assignmentMatch = trimmed.match(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/);
  const valuePart = assignmentMatch ? assignmentMatch[1].trim() : trimmed;

  const unquoted =
    valuePart.length >= 2 &&
    ((valuePart.startsWith('"') && valuePart.endsWith('"')) ||
      (valuePart.startsWith("'") && valuePart.endsWith("'")) ||
      (valuePart.startsWith("`") && valuePart.endsWith("`")))
      ? valuePart.slice(1, -1)
      : valuePart;

  const withoutSemicolon = unquoted.endsWith(";") ? unquoted.slice(0, -1) : unquoted;

  return withoutSemicolon.trim();
}

export const validateApiKeyInput = (value: string) =>
  normalizeApiKeyInput(value).length > 0 ? undefined : "Required";

export const FIREWORKS_API_KEY_PREFIX = "fw_";
export const FIREWORKS_API_KEY_MIN_LENGTH = 13; // fw_ + at least 10 characters

export function validateFireworksApiKey(raw: string): string | undefined {
  const trimmed = normalizeApiKeyInput(raw);
  if (!trimmed) return "Required";
  if (!trimmed.startsWith(FIREWORKS_API_KEY_PREFIX)) {
    return `Expected API key starting with ${FIREWORKS_API_KEY_PREFIX}`;
  }
  if (trimmed.length < FIREWORKS_API_KEY_MIN_LENGTH) {
    return "API key looks too short; paste the full key";
  }
  return undefined;
}

export function formatApiKeyPreview(
  raw: string,
  opts: { head?: number; tail?: number } = {},
): string {
  const trimmed = raw.trim();
  if (!trimmed) return "…";
  const head = opts.head ?? DEFAULT_KEY_PREVIEW.head;
  const tail = opts.tail ?? DEFAULT_KEY_PREVIEW.tail;
  if (trimmed.length <= head + tail) {
    const shortHead = Math.min(2, trimmed.length);
    const shortTail = Math.min(2, trimmed.length - shortHead);
    if (shortTail <= 0) {
      return `${trimmed.slice(0, shortHead)}…`;
    }
    return `${trimmed.slice(0, shortHead)}…${trimmed.slice(-shortTail)}`;
  }
  return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
}

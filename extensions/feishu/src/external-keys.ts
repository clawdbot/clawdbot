const CONTROL_CHARS_RE = /\p{Cc}/u;
const MAX_EXTERNAL_KEY_LENGTH = 512;

export function normalizeFeishuExternalKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_EXTERNAL_KEY_LENGTH) {
    return undefined;
  }
  if (CONTROL_CHARS_RE.test(normalized)) {
    return undefined;
  }
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    return undefined;
  }
  return normalized;
}

// Feishu plugin module implements external keys behavior.
// Unicode mode counts scalars, not UTF-16 units or grapheme clusters. Share the
// canonical pattern with exported config schemas so received and configured keys agree.
export const FEISHU_EXTERNAL_KEY_PATTERN =
  /^(?!\s)(?![\s\S]*\s$)(?![\s\S]*\.\.)[^\p{Cc}\p{Cs}/\\]{1,512}$/u;

export function normalizeFeishuExternalKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return FEISHU_EXTERNAL_KEY_PATTERN.test(normalized) ? normalized : undefined;
}

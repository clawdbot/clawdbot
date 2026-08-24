// Feishu config/Doctor helper keeps wildcard detection aligned with inbound runtime normalization.
const FEISHU_PROVIDER_PREFIX_RE = /^(feishu|lark):/i;
const FEISHU_TYPED_PREFIX_RE = /^(chat|group|channel|user|dm|open_id):/i;

export function isFeishuAllowFromWildcard(raw: string | number): boolean {
  let normalized = String(raw).trim();
  while (FEISHU_PROVIDER_PREFIX_RE.test(normalized)) {
    normalized = normalized.replace(FEISHU_PROVIDER_PREFIX_RE, "").trim();
  }
  if (normalized === "*") {
    return true;
  }
  const typedPrefix = normalized.match(FEISHU_TYPED_PREFIX_RE)?.[0];
  return typedPrefix ? normalized.slice(typedPrefix.length).trim() === "*" : false;
}

export function hasFeishuAllowFromWildcard(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (entry) =>
        (typeof entry === "string" || typeof entry === "number") &&
        isFeishuAllowFromWildcard(entry),
    )
  );
}

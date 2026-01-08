export function normalizeMessageProvider(
  raw?: string | null,
): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized === "imsg" ? "imessage" : normalized;
}

export function resolveMessageProvider(
  primary?: string | null,
  fallback?: string | null,
): string | undefined {
  return (
    normalizeMessageProvider(primary) ?? normalizeMessageProvider(fallback)
  );
}

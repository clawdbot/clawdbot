export function normalizeSignalMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let normalized = trimmed;
  if (normalized.toLowerCase().startsWith("signal:")) {
    normalized = normalized.slice("signal:".length).trim();
  }
  if (!normalized) return undefined;
  const lower = normalized.toLowerCase();
  if (lower.startsWith("group:")) {
    const id = normalized.slice("group:".length).trim();
    return id ? `group:${id}`.toLowerCase() : undefined;
  }
  if (lower.startsWith("username:")) {
    const id = normalized.slice("username:".length).trim();
    return id ? `username:${id}`.toLowerCase() : undefined;
  }
  if (lower.startsWith("u:")) {
    const id = normalized.slice("u:".length).trim();
    return id ? `username:${id}`.toLowerCase() : undefined;
  }
  return normalized.toLowerCase();
}

export function looksLikeSignalTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^(signal:)?(group:|username:|u:)/i.test(trimmed)) return true;
  return /^\+?\d{3,}$/.test(trimmed);
}

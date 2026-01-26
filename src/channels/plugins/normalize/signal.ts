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
  if (lower.startsWith("uuid:")) {
    const id = normalized.slice("uuid:".length).trim();
    return id ? id.toLowerCase() : undefined;
  }
  return normalized.toLowerCase();
}

// UUID pattern for signal-cli recipient IDs
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_PATTERN = /^[0-9a-f]{32}$/i;

export function looksLikeSignalTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^(signal:)?(group:|username:|u:)/i.test(trimmed)) return true;
  if (/^(signal:)?uuid:/i.test(trimmed)) {
    const stripped = trimmed
      .replace(/^signal:/i, "")
      .replace(/^uuid:/i, "")
      .trim();
    if (!stripped) return false;
    return UUID_PATTERN.test(stripped) || UUID_COMPACT_PATTERN.test(stripped);
  }
  // Accept UUIDs (used by signal-cli for reactions)
  if (UUID_PATTERN.test(trimmed) || UUID_COMPACT_PATTERN.test(trimmed)) return true;
  return /^\+?\d{3,}$/.test(trimmed);
}

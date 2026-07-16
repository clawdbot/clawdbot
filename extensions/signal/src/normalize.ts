import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export function normalizeSignalMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let normalized = trimmed;
  if (normalizeLowercaseStringOrEmpty(normalized).startsWith("signal:")) {
    normalized = normalized.slice("signal:".length).trim();
  }
  if (!normalized) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(normalized);
  if (lower.startsWith("group:")) {
    const id = normalized.slice("group:".length).trim();
    return id ? `group:${id}` : undefined;
  }
  if (lower.startsWith("username:")) {
    const id = normalized.slice("username:".length).trim();
    return id ? normalizeLowercaseStringOrEmpty(`username:${id}`) : undefined;
  }
  if (lower.startsWith("u:")) {
    const id = normalized.slice("u:".length).trim();
    return id ? normalizeLowercaseStringOrEmpty(`username:${id}`) : undefined;
  }
  if (lower.startsWith("uuid:")) {
    const id = normalized.slice("uuid:".length).trim();
    return id ? normalizeLowercaseStringOrEmpty(id) : undefined;
  }
  return normalizeLowercaseStringOrEmpty(normalized);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_PATTERN = /^[0-9a-f]{32}$/i;

export function looksLikeSignalTargetId(raw: string, normalized?: string): boolean {
  const candidates = [raw, normalized ?? ""].map((value) => value.trim()).filter(Boolean);

  for (const candidate of candidates) {
    if (/^(signal:)?(group:|username:|u:)/i.test(candidate)) {
      return true;
    }
    if (/^(signal:)?uuid:/i.test(candidate)) {
      const stripped = candidate
        .replace(/^signal:/i, "")
        .replace(/^uuid:/i, "")
        .trim();
      if (!stripped) {
        continue;
      }
      if (UUID_PATTERN.test(stripped) || UUID_COMPACT_PATTERN.test(stripped)) {
        return true;
      }
      continue;
    }

    const withoutSignalPrefix = candidate.replace(/^signal:/i, "").trim();
    if (UUID_PATTERN.test(withoutSignalPrefix) || UUID_COMPACT_PATTERN.test(withoutSignalPrefix)) {
      return true;
    }
    if (/^\+?\d{3,}$/.test(withoutSignalPrefix)) {
      return true;
    }
  }

  return false;
}

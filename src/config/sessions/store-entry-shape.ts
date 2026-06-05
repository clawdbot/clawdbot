// Store entry shape normalization rejects unsafe persisted metadata before runtime use.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { validateSessionId } from "./paths.js";
import type { SessionEntry } from "./types.js";

// Persisted stores may contain old or malformed ids; reject path-like ids before use.
function isSafeSessionId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 255) {
    return false;
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    return false;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(trimmed);
}

function normalizeTranscriptSessionId(value: string): string | undefined {
  try {
    return validateSessionId(value);
  } catch {
    return undefined;
  }
}

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Normalizes persisted session store entries before they reach runtime callers. */
export function normalizePersistedSessionEntryShape(value: unknown): SessionEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  let next = value as unknown as SessionEntry;
  const sessionFile = typeof value.sessionFile === "string" ? value.sessionFile.trim() : undefined;
  if (value.sessionId !== undefined) {
    if (!isSafeSessionId(value.sessionId)) {
      return undefined;
    }
    const sessionId = value.sessionId.trim();
    const transcriptSessionId = normalizeTranscriptSessionId(sessionId);
    if (!transcriptSessionId && !sessionFile) {
      // Old non-transcript ids can survive only when a separate sessionFile pins the path.
      const { sessionId: _dropSessionId, ...rest } = next;
      next = rest as SessionEntry;
    } else if (sessionId !== value.sessionId) {
      next = { ...next, sessionId };
    }
  }

  if (value.sessionFile !== undefined && typeof value.sessionFile !== "string") {
    if (next === value) {
      next = { ...next };
    }
    delete next.sessionFile;
  }

  const updatedAt = normalizeOptionalTimestamp(value.updatedAt);
  if (updatedAt !== value.updatedAt) {
    if (next === value) {
      next = { ...next };
    }
    next.updatedAt = updatedAt ?? 0;
  }

  return next;
}

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

  const modelSelectionLocked = value.modelSelectionLocked === true;
  const { sessionFile: _retiredSessionFile, ...canonicalValue } = value;
  let next = canonicalValue as unknown as SessionEntry;
  if (value.sessionId !== undefined) {
    if (!isSafeSessionId(value.sessionId)) {
      return undefined;
    }
    const sessionId = value.sessionId.trim();
    if (modelSelectionLocked && sessionId !== value.sessionId) {
      // A harness lock protects the exact durable identity. Repairing it here
      // would make a corrupted row look valid before ownership validation.
      return undefined;
    }
    const transcriptSessionId = normalizeTranscriptSessionId(sessionId);
    if (!transcriptSessionId) {
      if (modelSelectionLocked) {
        return undefined;
      }
      // Preserve unrelated metadata from old rows while withholding an ID
      // that cannot identify a canonical SQLite transcript.
      const { sessionId: _retiredSessionId, ...metadata } = next;
      next = metadata as SessionEntry;
    }
    if (transcriptSessionId && sessionId !== value.sessionId) {
      next = { ...next, sessionId };
    }
  }

  const updatedAt = normalizeOptionalTimestamp(value.updatedAt);
  if (updatedAt !== value.updatedAt) {
    next.updatedAt = updatedAt ?? 0;
  }

  return next;
}

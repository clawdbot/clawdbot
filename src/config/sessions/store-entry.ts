import { normalizeSessionKeyPreservingOpaquePeerIds } from "../../sessions/session-key-utils.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import type { SessionEntry } from "./types.js";

export function normalizeStoreSessionKey(sessionKey: string): string {
  return normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
}

export function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
  legacyKeys: string[];
} {
  const trimmedKey = params.sessionKey.trim();
  const normalizedKey = normalizeStoreSessionKey(trimmedKey);
  const foldedLegacyKey = normalizeLowercaseStringOrEmpty(normalizedKey);
  const legacyKeySet = new Set<string>();
  if (
    trimmedKey !== normalizedKey &&
    Object.prototype.hasOwnProperty.call(params.store, trimmedKey)
  ) {
    legacyKeySet.add(trimmedKey);
  }
  if (
    foldedLegacyKey !== normalizedKey &&
    Object.prototype.hasOwnProperty.call(params.store, foldedLegacyKey)
  ) {
    legacyKeySet.add(foldedLegacyKey);
  }
  let existing =
    params.store[normalizedKey] ??
    params.store[foldedLegacyKey] ??
    (legacyKeySet.size > 0 ? params.store[trimmedKey] : undefined);
  let existingUpdatedAt = existing?.updatedAt ?? 0;
  for (const [candidateKey, candidateEntry] of Object.entries(params.store)) {
    if (candidateKey === normalizedKey) {
      continue;
    }
    const candidateMatches =
      normalizeStoreSessionKey(candidateKey) === normalizedKey ||
      (foldedLegacyKey !== normalizedKey &&
        normalizeLowercaseStringOrEmpty(candidateKey) === foldedLegacyKey);
    if (!candidateMatches) {
      continue;
    }
    legacyKeySet.add(candidateKey);
    const candidateUpdatedAt = candidateEntry?.updatedAt ?? 0;
    if (!existing || candidateUpdatedAt > existingUpdatedAt) {
      existing = candidateEntry;
      existingUpdatedAt = candidateUpdatedAt;
    }
  }
  return {
    normalizedKey,
    existing,
    legacyKeys: [...legacyKeySet],
  };
}

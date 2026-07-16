// Store entry lookup resolves canonical keys and safe legacy aliases.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeSessionKeyPreservingOpaquePeerIds,
  parseThreadSessionSuffix,
  requiresFoldedSessionKeyAliasProof,
} from "../../sessions/session-key-utils.js";
import type { SessionEntry } from "./types.js";

export function normalizeStoreSessionKey(sessionKey: string): string {
  return normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
}

export function foldedSessionKeyAliasCandidates(normalizedKey: string): string[] {
  const aliases = new Set<string>();
  const foldedLegacyKey = normalizeLowercaseStringOrEmpty(normalizedKey);
  if (foldedLegacyKey !== normalizedKey) {
    aliases.add(foldedLegacyKey);
  }
  if (requiresFoldedSessionKeyAliasProof(normalizedKey)) {
    // Thread suffixes preserve their opaque thread id while only folding the legacy base key.
    const { baseSessionKey, threadId } = parseThreadSessionSuffix(normalizedKey);
    const foldedBaseKey = normalizeLowercaseStringOrEmpty(baseSessionKey);
    if (baseSessionKey && threadId && foldedBaseKey !== baseSessionKey) {
      aliases.add(`${foldedBaseKey}:thread:${threadId}`);
    }
  }
  return [...aliases];
}

/** The case-sensitive room/peer target an entry actually delivers to. Delivery
 *  metadata preserves the real opaque id even when the session KEY was lowercased
 *  by the bug, so it distinguishes a lowercased artifact from a distinct room. */
function normalizeEntryTarget(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  const sigilIndexes = ["!", "#"]
    .map((sigil) => trimmed.indexOf(sigil))
    .filter((index) => index >= 0);
  if (sigilIndexes.length === 0) {
    return trimmed;
  }
  return trimmed.slice(Math.min(...sigilIndexes));
}

function entryDeliveryTargets(entry: SessionEntry | undefined): string[] {
  const candidates = [
    entry?.deliveryContext?.to,
    entry?.lastTo,
    entry?.origin?.nativeChannelId,
    entry?.origin?.to,
    entry?.groupId,
  ];
  return candidates.map(normalizeEntryTarget).filter(Boolean);
}

function normalizeEntryThreadId(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }
  return String(value).trim();
}

function entryThreadId(entry: SessionEntry | undefined): string {
  return normalizeEntryThreadId(
    entry?.deliveryContext?.threadId ?? entry?.lastThreadId ?? entry?.origin?.threadId,
  );
}

/** Tail-preserved keys like Matrix rooms need delivery-target proof before a
 *  folded key is treated as a legacy alias. Segment-preserved legacy keys
 *  (Signal groups) keep their old permissive lowercase fallback. */
export function isConfirmedLowercasedLegacyAlias(
  entry: SessionEntry | undefined,
  normalizedKey: string,
): boolean {
  if (!entry) {
    return false;
  }
  if (!requiresFoldedSessionKeyAliasProof(normalizedKey)) {
    return true;
  }
  const { baseSessionKey, threadId } = parseThreadSessionSuffix(normalizedKey);
  const normalizedBaseKey = baseSessionKey ?? normalizedKey;
  const targetMatches = entryDeliveryTargets(entry).some((target) =>
    normalizedBaseKey.includes(target),
  );
  if (!targetMatches) {
    return false;
  }
  if (!threadId) {
    return true;
  }
  return entryThreadId(entry) === threadId;
}

export function hasMismatchedCaseSensitiveDeliveryProof(
  entry: SessionEntry | undefined,
  normalizedKey: string,
): boolean {
  if (!entry || !requiresFoldedSessionKeyAliasProof(normalizedKey)) {
    return false;
  }
  const { baseSessionKey, threadId } = parseThreadSessionSuffix(normalizedKey);
  const normalizedBaseKey = baseSessionKey ?? normalizedKey;
  const targets = entryDeliveryTargets(entry);
  // Existing delivery metadata is treated as proof against folding to a different opaque target.
  if (targets.length > 0 && !targets.some((target) => normalizedBaseKey.includes(target))) {
    return true;
  }
  const storedThreadId = entryThreadId(entry);
  return Boolean(threadId && storedThreadId && storedThreadId !== threadId);
}

type SessionEntryCandidate = {
  entry: SessionEntry;
  sessionKey: string;
};

export function resolveSessionEntryCandidates(params: {
  entries: readonly SessionEntryCandidate[];
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntryCandidate | undefined;
  legacyKeys: string[];
} {
  const trimmedKey = params.sessionKey.trim();
  const normalizedKey = normalizeStoreSessionKey(trimmedKey);
  const foldedLegacyKeys = foldedSessionKeyAliasCandidates(normalizedKey);
  const entries = new Map(params.entries.map((candidate) => [candidate.sessionKey, candidate]));
  const legacyKeySet = new Set<string>();
  const trimmedCandidate = entries.get(trimmedKey);
  if (
    trimmedKey !== normalizedKey &&
    trimmedCandidate &&
    !hasMismatchedCaseSensitiveDeliveryProof(trimmedCandidate.entry, normalizedKey)
  ) {
    legacyKeySet.add(trimmedKey);
  }
  // Matrix folded aliases need proof they still deliver to this room. Otherwise a
  // genuinely case-distinct sibling that merely folds to the same lowercase could
  // be deleted or returned as this room's existing session.
  let foldedLegacyEntry: SessionEntryCandidate | undefined;
  let foldedLegacyUpdatedAt = 0;
  for (const foldedLegacyKey of foldedLegacyKeys) {
    const candidate = entries.get(foldedLegacyKey);
    if (!candidate || !isConfirmedLowercasedLegacyAlias(candidate.entry, normalizedKey)) {
      continue;
    }
    legacyKeySet.add(foldedLegacyKey);
    const updatedAt = candidate.entry.updatedAt ?? 0;
    if (!foldedLegacyEntry || updatedAt > foldedLegacyUpdatedAt) {
      foldedLegacyEntry = candidate;
      foldedLegacyUpdatedAt = updatedAt;
    }
  }
  // An exact (opaque-preserving-normalized) entry always wins over any folded
  // legacy alias, regardless of freshness (openclaw#75670). Only when no exact
  // entry exists do we fall back to a confirmed legacy alias.
  const exactEntry = entries.get(normalizedKey);
  const usableExactEntry = hasMismatchedCaseSensitiveDeliveryProof(exactEntry?.entry, normalizedKey)
    ? undefined
    : exactEntry;
  const exactKeyWins = requiresFoldedSessionKeyAliasProof(normalizedKey);
  const fallbackLegacyEntry =
    legacyKeySet.size > 0 &&
    !hasMismatchedCaseSensitiveDeliveryProof(trimmedCandidate?.entry, normalizedKey)
      ? trimmedCandidate
      : undefined;
  let existing = exactKeyWins
    ? (usableExactEntry ?? foldedLegacyEntry ?? fallbackLegacyEntry)
    : undefined;
  let existingUpdatedAt = existing?.entry.updatedAt ?? 0;
  if (!exactKeyWins) {
    for (const candidate of [usableExactEntry, foldedLegacyEntry, fallbackLegacyEntry]) {
      const candidateUpdatedAt = candidate?.entry.updatedAt ?? 0;
      if (candidate && (!existing || candidateUpdatedAt > existingUpdatedAt)) {
        existing = candidate;
        existingUpdatedAt = candidateUpdatedAt;
      }
    }
  }
  for (const [candidateKey, candidate] of entries) {
    if (candidateKey === normalizedKey) {
      continue;
    }
    // Only collapse TRUE canonical aliases (same opaque-preserving key, e.g. a
    // structural-token-case variant). Do NOT collapse keys that merely fold to the
    // same lowercase — those can be case-distinct Matrix rooms that must survive.
    if (normalizeStoreSessionKey(candidateKey) !== normalizedKey) {
      continue;
    }
    if (hasMismatchedCaseSensitiveDeliveryProof(candidate.entry, normalizedKey)) {
      continue;
    }
    legacyKeySet.add(candidateKey);
    const candidateUpdatedAt = candidate.entry.updatedAt ?? 0;
    if (!existing || candidateUpdatedAt > existingUpdatedAt) {
      existing = candidate;
      existingUpdatedAt = candidateUpdatedAt;
    }
  }
  return {
    normalizedKey,
    existing,
    legacyKeys: [...legacyKeySet],
  };
}

export function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
  legacyKeys: string[];
} {
  const resolved = resolveSessionEntryCandidates({
    entries: Object.entries(params.store).map(([sessionKey, entry]) => ({ entry, sessionKey })),
    sessionKey: params.sessionKey,
  });
  return {
    normalizedKey: resolved.normalizedKey,
    existing: resolved.existing?.entry,
    legacyKeys: resolved.legacyKeys,
  };
}

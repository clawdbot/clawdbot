import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { projectSessionEntriesForListing } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type {
  SessionAccessScope,
  SessionEntryCreateWithTranscriptContext,
} from "./session-accessor.types.js";
import {
  collectSessionEntryLookupKeys,
  normalizeStoreSessionKey,
  resolveSessionEntryCandidates,
} from "./store-entry.js";

/** Owns the complete target payload and sibling-label facts before asynchronous preparation. */
export function readSessionCreationSnapshot(
  scope: SessionAccessScope,
): SessionEntryCreateWithTranscriptContext & {
  normalizedKey: string;
  legacyKeys: string[];
} {
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
  // Listing validation rejects other structural aliases; these candidates retain
  // complete payloads in the same SELECT that captures sibling label metadata.
  const snapshot = readSessionEntryCache(database, {
    cache: false,
    projection: "list",
    fullEntryKeys: [
      normalizeStoreSessionKey(scope.sessionKey),
      ...collectSessionEntryLookupKeys(database, scope.sessionKey),
    ],
  });
  const entries = projectSessionEntriesForListing(snapshot);
  const resolved = resolveSessionEntryCandidates({ entries, sessionKey: scope.sessionKey });
  const targetEntry = entries.find(
    ({ sessionKey }) => sessionKey === resolved.normalizedKey,
  )?.entry;
  const labels = new Set<string | undefined>();
  for (const { sessionKey, entry } of entries) {
    if (sessionKey !== resolved.normalizedKey) {
      labels.add(entry.label);
    }
  }
  return {
    normalizedKey: resolved.normalizedKey,
    legacyKeys: resolved.legacyKeys,
    existingEntry: resolved.existing ? { ...resolved.existing.entry } : undefined,
    targetEntry: targetEntry ? { ...targetEntry } : undefined,
    isLabelInUse: (label) => labels.has(label),
  };
}

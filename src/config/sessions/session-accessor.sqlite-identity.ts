import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { emitSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import type { SessionEntry } from "./types.js";

type SqliteSessionEntryRemovalIdentity = {
  expectedEntry?: SessionEntry;
  sessionKey: string;
};

type SqliteProjectedLifecycleIdentityMutation = {
  removals: Array<{
    expectedEntry: SessionEntry;
    sessionKey: string;
  }>;
  upsertedEntries: Array<{
    entry: SessionEntry;
    expectedEntry: SessionEntry | undefined;
    sessionKey: string;
  }>;
};

function toSessionIdentityTarget(entry: SessionEntry | undefined, sessionKeys: readonly string[]) {
  const sessionId = normalizeOptionalString(entry?.sessionId);
  return { ...(sessionId ? { sessionId } : {}), sessionKeys };
}

function emitCommittedSessionEntryRemoval(sessionKey: string, entry?: SessionEntry): void {
  emitSessionIdentityMutation({
    kind: "delete",
    previous: toSessionIdentityTarget(entry, [sessionKey]),
  });
}

export function emitCommittedSessionEntryRemovals(
  removals: readonly SqliteSessionEntryRemovalIdentity[],
): void {
  const emittedKeys = new Set<string>();
  for (const removal of removals) {
    if (emittedKeys.has(removal.sessionKey)) {
      continue;
    }
    emittedKeys.add(removal.sessionKey);
    emitCommittedSessionEntryRemoval(removal.sessionKey, removal.expectedEntry);
  }
}

export function emitCommittedSessionEntryChange(params: {
  currentKey: string;
  currentEntry: SessionEntry;
  previousKey: string;
  previousEntry: SessionEntry;
}): void {
  const previous = toSessionIdentityTarget(params.previousEntry, [params.previousKey]);
  const current = toSessionIdentityTarget(params.currentEntry, [params.currentKey]);
  const moved = params.previousKey !== params.currentKey;
  if (!moved && previous.sessionId === current.sessionId) {
    return;
  }
  emitSessionIdentityMutation({
    kind: moved ? "move" : "replace",
    previous,
    current,
  });
}

export function emitCommittedSessionIdentityDiff(
  previous: ReadonlyMap<string, SessionEntry>,
  current: ReadonlyMap<string, SessionEntry>,
): void {
  const currentKeysBySessionId = new Map<string, string[]>();
  for (const [sessionKey, entry] of current) {
    const sessionId = normalizeOptionalString(entry.sessionId);
    if (sessionId) {
      currentKeysBySessionId.set(sessionId, [
        ...(currentKeysBySessionId.get(sessionId) ?? []),
        sessionKey,
      ]);
    }
  }

  const movedKeysByCurrentKey = new Map<string, string[]>();
  const handledPreviousKeys = new Set<string>();
  const handledCurrentKeys = new Set<string>();
  for (const [sessionKey, entry] of previous) {
    if (current.has(sessionKey)) {
      continue;
    }
    const sessionId = normalizeOptionalString(entry.sessionId);
    const currentKeys = sessionId ? currentKeysBySessionId.get(sessionId) : undefined;
    if (currentKeys?.length !== 1) {
      continue;
    }
    const [currentKey] = currentKeys;
    if (!currentKey) {
      continue;
    }
    movedKeysByCurrentKey.set(currentKey, [
      ...(movedKeysByCurrentKey.get(currentKey) ?? []),
      sessionKey,
    ]);
    handledPreviousKeys.add(sessionKey);
    handledCurrentKeys.add(currentKey);
  }
  for (const [currentKey, previousKeys] of movedKeysByCurrentKey) {
    const currentEntry = current.get(currentKey);
    if (currentEntry) {
      emitSessionIdentityMutation({
        kind: "move",
        previous: toSessionIdentityTarget(currentEntry, previousKeys),
        current: toSessionIdentityTarget(currentEntry, [currentKey]),
      });
    }
  }

  for (const [sessionKey, previousEntry] of previous) {
    const currentEntry = current.get(sessionKey);
    if (currentEntry) {
      handledCurrentKeys.add(sessionKey);
      emitCommittedSessionEntryChange({
        currentEntry,
        currentKey: sessionKey,
        previousEntry,
        previousKey: sessionKey,
      });
    } else if (!handledPreviousKeys.has(sessionKey)) {
      emitCommittedSessionEntryRemoval(sessionKey, previousEntry);
    }
  }

  for (const [sessionKey, currentEntry] of current) {
    if (handledCurrentKeys.has(sessionKey)) {
      continue;
    }
    emitSessionIdentityMutation({
      kind: "create",
      previous: { sessionKeys: [] },
      current: toSessionIdentityTarget(currentEntry, [sessionKey]),
    });
  }
}

export function emitCommittedLifecycleIdentityMutations(params: {
  projected: SqliteProjectedLifecycleIdentityMutation;
  removedSessionKeys: readonly string[];
}): void {
  const removedKeys = new Set(params.removedSessionKeys);
  const previous = new Map(
    params.projected.removals
      .filter((removal) => removedKeys.has(removal.sessionKey))
      .map((removal) => [removal.sessionKey, removal.expectedEntry]),
  );
  const current = new Map<string, SessionEntry>();
  for (const upsert of params.projected.upsertedEntries) {
    if (!current.has(upsert.sessionKey) && upsert.expectedEntry) {
      previous.set(upsert.sessionKey, upsert.expectedEntry);
    }
    current.set(upsert.sessionKey, upsert.entry);
  }
  emitCommittedSessionIdentityDiff(previous, current);
}

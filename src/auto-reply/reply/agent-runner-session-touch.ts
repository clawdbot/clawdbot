// Keeps the active session entry's updatedAt fresh while an agent run is in flight.
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";

type TouchActiveSessionEntryDeps = {
  getActiveSessionEntry: () => SessionEntry | undefined;
  getActiveSessionStore: () => Record<string, SessionEntry> | undefined;
  sessionKey?: string;
  storePath?: string;
};

/**
 * Builds the run-scoped session touch used to keep an in-flight turn's session
 * entry warm. The entry and store are read through getters because the run
 * rebinds them across admission, reset, and compaction boundaries.
 */
export function createTouchActiveSessionEntry({
  getActiveSessionEntry,
  getActiveSessionStore,
  sessionKey,
  storePath,
}: TouchActiveSessionEntryDeps): () => Promise<void> {
  return async () => {
    const activeSessionEntry = getActiveSessionEntry();
    const activeSessionStore = getActiveSessionStore();
    if (!activeSessionEntry || !activeSessionStore || !sessionKey) {
      return;
    }
    const updatedAt = Date.now();
    activeSessionEntry.updatedAt = updatedAt;
    activeSessionStore[sessionKey] = activeSessionEntry;
    if (storePath) {
      await updateSessionEntry({ storePath, sessionKey }, () => ({ updatedAt }), {
        skipMaintenance: true,
        takeCacheOwnership: true,
      });
    }
  };
}

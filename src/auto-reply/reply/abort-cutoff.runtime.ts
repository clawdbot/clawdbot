import { resolveBookkeepingUpdatedAt } from "../../config/sessions/reset.js";
/** Runtime persistence helper for clearing abort-cutoff state from sessions. */
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { applyAbortCutoffToSessionEntry, hasAbortCutoff } from "./abort-cutoff.js";

/** Clears abort cutoff state in memory and persisted session storage. */
export async function clearAbortCutoffInSessionRuntime(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}): Promise<boolean> {
  const { sessionEntry, sessionStore, sessionKey, storePath } = params;
  if (!sessionEntry || !sessionStore || !sessionKey || !hasAbortCutoff(sessionEntry)) {
    return false;
  }

  applyAbortCutoffToSessionEntry(sessionEntry, undefined);
  // Bookkeeping clear must not consume the legacy updatedAt=0 pending-reset marker.
  const updatedAt = resolveBookkeepingUpdatedAt(sessionEntry.updatedAt);
  sessionEntry.updatedAt = updatedAt;
  sessionStore[sessionKey] = sessionEntry;

  if (storePath) {
    await patchSessionEntryCore(
      { storePath, sessionKey },
      (entry) => ({
        abortCutoffMessageSid: undefined,
        abortCutoffTimestamp: undefined,
        updatedAt: resolveBookkeepingUpdatedAt(entry.updatedAt),
      }),
      { fallbackEntry: sessionEntry },
    );
  }

  return true;
}

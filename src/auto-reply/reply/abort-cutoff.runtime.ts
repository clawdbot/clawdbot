/** Runtime persistence helper for clearing abort-cutoff state from sessions. */
import { patchSessionEntry } from "../../config/sessions/session-accessor.js";
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
  const updatedAt = Date.now();
  sessionEntry.updatedAt = updatedAt;
  sessionStore[sessionKey] = sessionEntry;

  if (storePath) {
    await patchSessionEntry(
      { storePath, sessionKey },
      () => ({
        abortCutoffMessageSid: undefined,
        abortCutoffTimestamp: undefined,
        updatedAt,
      }),
      { fallbackEntry: sessionEntry },
    );
  }

  return true;
}

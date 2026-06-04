/** Runtime persistence helper for clearing abort-cutoff state from sessions. */
import { updateSessionStore } from "../../config/sessions/store.js";
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
  sessionEntry.updatedAt = Date.now();
  sessionStore[sessionKey] = sessionEntry;

  if (storePath) {
    await updateSessionStore(storePath, (store) => {
      const existing = store[sessionKey] ?? sessionEntry;
      if (!existing) {
        return;
      }
      applyAbortCutoffToSessionEntry(existing, undefined);
      existing.updatedAt = Date.now();
      store[sessionKey] = existing;
    });
  }

  return true;
}

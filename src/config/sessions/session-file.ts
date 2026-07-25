// Session file persistence syncs active session transcript markers into store metadata.
import { normalizeAgentId } from "../../routing/session-key.js";
import { upsertSessionEntry } from "./session-accessor.js";
import { formatSqliteSessionFileMarker } from "./sqlite-marker.js";
import type { SessionEntry } from "./types.js";

/** Resolves the active SQLite transcript marker and persists it into the session store when needed. */
export async function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry }> {
  const { sessionId, sessionKey, sessionStore, storePath } = params;
  const now = Date.now();
  const baseEntry = params.sessionEntry ??
    sessionStore[sessionKey] ?? { sessionId, updatedAt: now, sessionStartedAt: now };
  const sessionFile = formatSqliteSessionFileMarker({
    agentId: normalizeAgentId(params.agentId),
    sessionId,
    storePath,
  });
  const persistedEntry: SessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: now,
    sessionStartedAt: baseEntry.sessionId === sessionId ? (baseEntry.sessionStartedAt ?? now) : now,
    sessionFile,
  };
  if (baseEntry.sessionId !== sessionId || baseEntry.sessionFile !== sessionFile) {
    sessionStore[sessionKey] = persistedEntry;
    await upsertSessionEntry({ storePath, sessionKey }, persistedEntry);
    return { sessionFile, sessionEntry: persistedEntry };
  }
  sessionStore[sessionKey] = persistedEntry;
  return { sessionFile, sessionEntry: persistedEntry };
}

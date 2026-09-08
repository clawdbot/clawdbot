/** Shared session persistence for agent attempt execution. */
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { mergeSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import type { SessionEntry } from "../../config/sessions/types.js";
/** Parameters for merging and persisting a session entry update. */
type PersistSessionEntryParams = {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  initialEntry: SessionEntry;
  entry: SessionEntry;
  shouldPersist?: (entry: SessionEntry | undefined) => boolean;
};

/** Persists one session entry while keeping the caller's in-memory store aligned. */
export async function persistAgentSession(
  params: PersistSessionEntryParams,
): Promise<SessionEntry | undefined> {
  let rejectedMissingEntry = false;
  const persisted = await patchSessionEntryCore(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) => {
      const shouldPersistCurrent = params.shouldPersist?.(context.existingEntry);
      if (!context.existingEntry && shouldPersistCurrent !== true) {
        rejectedMissingEntry = true;
        return null;
      }
      if (shouldPersistCurrent === false) {
        rejectedMissingEntry = !context.existingEntry;
        return null;
      }
      if (!context.existingEntry) {
        return params.entry;
      }
      if (context.existingEntry.sessionId !== params.initialEntry.sessionId) {
        return null;
      }
      // Agent turns persist broad snapshots. Project only this turn's changes
      // so a stale snapshot cannot restore fields changed or cleared meanwhile.
      return mergeSessionSnapshotChanges({
        initial: params.initialEntry,
        next: params.entry,
        current: context.existingEntry,
      });
    },
    {
      fallbackEntry: params.sessionStore[params.sessionKey] ?? params.entry,
      replaceEntry: true,
    },
  );
  if (rejectedMissingEntry) {
    delete params.sessionStore[params.sessionKey];
    return undefined;
  }
  if (persisted) {
    params.sessionStore[params.sessionKey] = persisted;
  } else {
    delete params.sessionStore[params.sessionKey];
  }
  return persisted ?? undefined;
}

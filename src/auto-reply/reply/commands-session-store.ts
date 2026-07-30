// Shared session-store helpers for command handlers that mutate sessions.
import { resolveSessionStoreEntry, type SessionEntry } from "../../config/sessions.js";
import { patchSessionEntry } from "../../config/sessions/session-accessor.js";
import { sessionSnapshotChangesApplied } from "../../config/sessions/session-snapshot-merge.js";
import { applyAbortCutoffToSessionEntry, type AbortCutoff } from "./abort-cutoff.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";
import { persistReplySessionEntry } from "./session-entry-persistence.js";

type CommandParams = Parameters<CommandHandler>[0];
type PersistSessionEntryParams = Pick<
  CommandParams,
  | "allowCreateSessionEntry"
  | "initialSessionEntry"
  | "sessionEntry"
  | "sessionKey"
  | "sessionStore"
  | "storePath"
> & { touchedFields?: ReadonlyArray<keyof SessionEntry> };

/** Resolves a command target entry through canonical and legacy session keys. */
export function resolveCommandSessionEntryForKey(
  store: Record<string, SessionEntry> | undefined,
  sessionKey: string | undefined,
): { entry?: SessionEntry; key?: string } {
  if (!store || !sessionKey) {
    return {};
  }
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  if (!resolved.existing) {
    return {};
  }
  return {
    entry: resolved.existing,
    key: resolved.normalizedKey,
  };
}

export async function persistSessionEntry(params: PersistSessionEntryParams): Promise<boolean> {
  if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
    return false;
  }
  const sessionEntry = params.sessionEntry;
  const creatingSession = params.allowCreateSessionEntry === true;
  const initialEntry = params.initialSessionEntry ?? { ...sessionEntry };
  sessionEntry.updatedAt = Date.now();
  params.sessionStore[params.sessionKey] = sessionEntry;
  if (params.storePath) {
    // Slash commands mutate one known session entry; skipping global session
    // maintenance avoids scanning the whole sessions directory for simple
    // command-only writes.
    const persistence = await persistReplySessionEntry({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      allowCreate: creatingSession,
      initialEntry,
      entry: sessionEntry,
      skipMaintenance: true,
      touchedFields: params.touchedFields,
    });
    if (persistence.status === "lifecycle-invalidated") {
      if (persistence.entry) {
        params.sessionStore[params.sessionKey] = persistence.entry;
      }
      return false;
    }
    params.sessionStore[params.sessionKey] = persistence.entry;
    return sessionSnapshotChangesApplied({
      initial: initialEntry,
      next: sessionEntry,
      current: persistence.entry,
      touchedFields: params.touchedFields,
    });
  }
  return true;
}

export function sessionEntryPersistenceConflictReply(): CommandHandlerResult {
  return {
    shouldContinue: false,
    reply: { text: "⚠️ Session changed before this setting could be saved. Retry the command." },
  };
}

export async function persistAbortTargetEntry(params: {
  entry?: SessionEntry;
  key?: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  abortCutoff?: AbortCutoff;
}): Promise<boolean> {
  const { entry, key, sessionStore, storePath, abortCutoff } = params;
  if (!entry || !key || !sessionStore) {
    return false;
  }

  entry.abortedLastRun = true;
  applyAbortCutoffToSessionEntry(entry, abortCutoff);
  entry.updatedAt = Date.now();
  sessionStore[key] = entry;

  if (storePath) {
    await patchSessionEntry(
      { storePath, sessionKey: key },
      (nextEntry) => {
        nextEntry.abortedLastRun = true;
        applyAbortCutoffToSessionEntry(nextEntry, abortCutoff);
        nextEntry.updatedAt = Date.now();
        return nextEntry;
      },
      {
        fallbackEntry: entry,
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
  }

  return true;
}

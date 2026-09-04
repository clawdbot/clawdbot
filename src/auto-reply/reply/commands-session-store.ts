// Shared session-store helpers for command handlers that mutate sessions.
import { resolveSessionStoreEntryCore, type SessionEntry } from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
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
  const resolved = resolveSessionStoreEntryCore({ store, sessionKey });
  if (!resolved.existing) {
    return {};
  }
  return {
    entry: resolved.existing,
    key: resolved.normalizedKey,
  };
}

export async function persistCommandSession(params: PersistSessionEntryParams): Promise<boolean> {
  if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
    return false;
  }
  const sessionEntry = params.sessionEntry;
  const creatingSession = params.allowCreateSessionEntry === true;
  const initialEntry = params.initialSessionEntry ?? { ...sessionEntry };
  // Keep command bookkeeping aligned with the pending-reset write boundary.
  sessionEntry.updatedAt = !creatingSession && initialEntry.updatedAt === 0 ? 0 : Date.now();
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
  isCurrent?: () => boolean;
  entry?: SessionEntry;
  key?: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  abortCutoff?: AbortCutoff;
}): Promise<boolean> {
  const { entry, key, sessionStore, storePath, abortCutoff } = params;
  if (!entry || !key || !sessionStore || params.isCurrent?.() === false) {
    return false;
  }

  entry.abortedLastRun = true;
  applyAbortCutoffToSessionEntry(entry, abortCutoff);
  // Abort bookkeeping does not satisfy the pending reset.
  entry.updatedAt = entry.updatedAt === 0 ? 0 : Date.now();
  sessionStore[key] = entry;

  if (storePath) {
    let applied = false;
    await patchSessionEntryCore(
      { storePath, sessionKey: key },
      (nextEntry) => {
        if (params.isCurrent?.() === false) {
          return null;
        }
        applied = true;
        nextEntry.abortedLastRun = true;
        applyAbortCutoffToSessionEntry(nextEntry, abortCutoff);
        nextEntry.updatedAt = nextEntry.updatedAt === 0 ? 0 : Date.now();
        return nextEntry;
      },
      {
        fallbackEntry: entry,
        replaceEntry: true,
        skipMaintenance: true,
        // Reassignment can leave the selected row unchanged across the patch await.
        assertCommitAllowed: () => {
          if (applied && params.isCurrent?.() === false) {
            throw new Error("The selected session changed before it could be stopped.");
          }
        },
      },
    );
    return applied;
  }

  return true;
}

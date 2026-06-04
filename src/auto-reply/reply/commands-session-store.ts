// Shared session-store helpers for command handlers that mutate sessions.
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { applyAbortCutoffToSessionEntry, type AbortCutoff } from "./abort-cutoff.js";
import type { CommandHandler } from "./commands-types.js";

type CommandParams = Parameters<CommandHandler>[0];

export async function persistSessionEntry(params: CommandParams): Promise<boolean> {
  if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
    return false;
  }
  params.sessionEntry.updatedAt = Date.now();
  params.sessionStore[params.sessionKey] = params.sessionEntry;
  if (params.storePath) {
    // Slash commands mutate one known session entry; skipping global session
    // maintenance avoids scanning the whole sessions directory for simple
    // command-only writes.
    await updateSessionStore(
      params.storePath,
      (store) => {
        store[params.sessionKey] = params.sessionEntry as SessionEntry;
        return params.sessionEntry as SessionEntry;
      },
      {
        resolveSingleEntryPersistence: (entry) =>
          entry ? { sessionKey: params.sessionKey, entry } : null,
        skipMaintenance: true,
      },
    );
  }
  return true;
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
    await updateSessionStore(
      storePath,
      (store) => {
        const nextEntry = store[key] ?? entry;
        if (!nextEntry) {
          return undefined;
        }
        nextEntry.abortedLastRun = true;
        applyAbortCutoffToSessionEntry(nextEntry, abortCutoff);
        nextEntry.updatedAt = Date.now();
        store[key] = nextEntry;
        return nextEntry;
      },
      {
        resolveSingleEntryPersistence: (updated) =>
          updated ? { sessionKey: key, entry: updated } : null,
      },
    );
  }

  return true;
}

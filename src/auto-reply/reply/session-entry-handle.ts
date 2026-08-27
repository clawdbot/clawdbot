// Narrow mutable handle for the active reply session entry.
import type { SessionEntry } from "../../config/sessions.js";

export type ReplySessionEntryHandle = {
  adoptCurrent(entry: SessionEntry): void;
  clearCurrent(): void;
  get(sessionKey: string): SessionEntry | undefined;
  getCurrent(): SessionEntry | undefined;
  patchCurrent(patch: Partial<SessionEntry>): SessionEntry | undefined;
  replaceCurrent(entry: SessionEntry): void;
  set(sessionKey: string, entry: SessionEntry): void;
  toCompatSessionStore(): Record<string, SessionEntry>;
};

export class ReplySessionGenerationInvalidatedError extends Error {}

export function createReplySessionEntryHandle(params: {
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  generationFence?: {
    sessionId: string;
    expectedStoreEntry?: SessionEntry;
  };
}): ReplySessionEntryHandle {
  const { generationFence, sessionKey, sessionStore } = params;
  const entries = sessionStore ?? {};
  let ownedSessionId = generationFence?.sessionId;
  let ownedLifecycleRevision =
    params.sessionEntry && params.sessionEntry.sessionId === ownedSessionId
      ? params.sessionEntry.lifecycleRevision
      : undefined;
  const matchesGeneration = (entry: SessionEntry | undefined): entry is SessionEntry =>
    entry !== undefined &&
    (!generationFence ||
      (entry.sessionId === ownedSessionId && entry.lifecycleRevision === ownedLifecycleRevision));
  let currentEntry = matchesGeneration(params.sessionEntry) ? params.sessionEntry : undefined;

  if (sessionKey && currentEntry) {
    const storedEntry = entries[sessionKey];
    if (
      !generationFence ||
      !sessionStore ||
      (storedEntry &&
        ((storedEntry === generationFence.expectedStoreEntry && !matchesGeneration(storedEntry)) ||
          (matchesGeneration(storedEntry) && currentEntry.updatedAt >= storedEntry.updatedAt)))
    ) {
      entries[sessionKey] = currentEntry;
    }
  }

  const current = (): SessionEntry | undefined => {
    const storedEntry = sessionKey ? entries[sessionKey] : undefined;
    if (
      generationFence &&
      matchesGeneration(storedEntry) &&
      (!currentEntry || storedEntry.updatedAt >= currentEntry.updatedAt)
    ) {
      currentEntry = storedEntry;
    }
    return currentEntry;
  };

  const replaceCurrent = (entry: SessionEntry, adopt = false): void => {
    if (!generationFence) {
      currentEntry = entry;
      if (sessionKey) {
        entries[sessionKey] = entry;
      }
      return;
    }
    const storedEntry = sessionKey ? entries[sessionKey] : undefined;
    const storedMatchesOwned = matchesGeneration(storedEntry);
    let nextEntry = entry;
    if (adopt) {
      const storedMatchesAdopted = Boolean(
        storedEntry &&
        storedEntry.sessionId === entry.sessionId &&
        storedEntry.lifecycleRevision === entry.lifecycleRevision,
      );
      if (
        (sessionStore && sessionKey && !storedEntry && generationFence.expectedStoreEntry) ||
        (storedEntry && !storedMatchesOwned && !storedMatchesAdopted)
      ) {
        throw new ReplySessionGenerationInvalidatedError(
          "Follow-up session generation was replaced during admission",
        );
      }
      if (storedMatchesAdopted && storedEntry && storedEntry.updatedAt >= entry.updatedAt) {
        nextEntry = storedEntry;
      }
      ownedSessionId = nextEntry.sessionId;
      ownedLifecycleRevision = nextEntry.lifecycleRevision;
    } else if (!matchesGeneration(nextEntry)) {
      return;
    }
    if (adopt || !currentEntry || nextEntry.updatedAt >= currentEntry.updatedAt) {
      currentEntry = nextEntry;
    }
    if (
      sessionKey &&
      (adopt
        ? !storedEntry || storedMatchesOwned || nextEntry !== storedEntry
        : (!storedEntry && !generationFence.expectedStoreEntry) ||
          (storedMatchesOwned && storedEntry && nextEntry.updatedAt >= storedEntry.updatedAt))
    ) {
      entries[sessionKey] = nextEntry;
    }
  };

  const handle: ReplySessionEntryHandle = {
    adoptCurrent: (entry) => replaceCurrent(entry, true),
    clearCurrent: () => {
      currentEntry = undefined;
      if (sessionKey && (!generationFence || matchesGeneration(entries[sessionKey]))) {
        delete entries[sessionKey];
      }
    },
    get: (key) => entries[key],
    getCurrent: current,
    patchCurrent: (patch) => {
      if (currentEntry) {
        replaceCurrent({ ...currentEntry, ...patch });
      }
      return currentEntry;
    },
    replaceCurrent,
    set: (key, entry) => {
      if (key === sessionKey) {
        replaceCurrent(entry);
      } else {
        entries[key] = entry;
      }
    },
    toCompatSessionStore: () => {
      if (!generationFence || !sessionKey) {
        return entries;
      }
      const view = { ...entries, ...(currentEntry ? { [sessionKey]: currentEntry } : {}) };
      return new Proxy(view, {
        get: (target, key) => (key === sessionKey ? current() : Reflect.get(target, key)),
        set(target, key, entry: SessionEntry | undefined) {
          if (key !== sessionKey) {
            return Reflect.set(target, key, entry);
          }
          if (!entry) {
            handle.clearCurrent();
          } else {
            replaceCurrent(entry, !matchesGeneration(entry));
          }
          return true;
        },
        deleteProperty(target, key) {
          if (key !== sessionKey) {
            return Reflect.deleteProperty(target, key);
          }
          // A stale owner may clear only its generation, never a concurrent replacement.
          handle.clearCurrent();
          return true;
        },
      });
    },
  };

  return handle;
}

// Read-only session store loading uses SQLite without creating or repairing state.
import { cloneSessionStoreRecord } from "./store-cache.js";
import { normalizeSessionStore } from "./store-load.js";
import { loadExistingSqliteSessionStoreReadOnly } from "./store-sqlite.js";
import type { SessionEntry } from "./types.js";

/** Reads a session store without mutating it and drops malformed entries. */
export function readSessionStoreReadOnly(
  storePath: string,
): Record<string, SessionEntry | undefined> {
  try {
    const store = loadExistingSqliteSessionStoreReadOnly(storePath);
    normalizeSessionStore(store);
    return cloneSessionStoreRecord(store);
  } catch {
    return {};
  }
}

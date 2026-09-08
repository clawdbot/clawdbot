import { clearBootRecords } from "../../app/boot-record.ts";
import { isPrimarySessionListQuery } from "./session-list-query.ts";
import {
  openSessionRosterDatabase,
  parseSessionRosterRecord,
  resetSessionRosterDatabase,
  rosterRequestResult,
  rosterTransactionDone,
  sessionRosterQuery,
  isPersistableSessionRow,
  stripVolatileSessionRowFields,
} from "./session-roster-cache.reader.ts";
import {
  invalidateSessionRosterCache,
  SESSION_ROSTER_MAX_AGE_MS,
  SESSION_ROSTER_MAX_BYTES,
  SESSION_ROSTER_STORE_NAME,
  sessionRosterCacheGeneration,
  type SessionRosterRecord,
} from "./session-roster-cache.ts";

const pending = new Map<string, SessionRosterRecord>();
let timer: ReturnType<typeof setTimeout> | null = null;
let writeChain = Promise.resolve();

function boundedRecord(record: SessionRosterRecord): SessionRosterRecord | null {
  try {
    if (!isPrimarySessionListQuery(record.query)) {
      return null;
    }
    const stripped = {
      ...record,
      query: sessionRosterQuery(record.query),
      result: {
        ...record.result,
        sessions: record.result.sessions
          .filter(isPersistableSessionRow)
          .map(stripVolatileSessionRowFields),
      },
    };
    const json = JSON.stringify(stripped, (key, value: unknown) =>
      key === "avatarUrl" || key === "channelAvatarUrl" ? undefined : value,
    );
    return new TextEncoder().encode(json).byteLength <= SESSION_ROSTER_MAX_BYTES
      ? parseSessionRosterRecord(JSON.parse(json))
      : null;
  } catch {
    return null;
  }
}

async function writeRecords(records: SessionRosterRecord[], generation: number): Promise<void> {
  if (generation !== sessionRosterCacheGeneration) {
    return;
  }
  const database = await openSessionRosterDatabase();
  if (!database) {
    return;
  }
  try {
    if (generation !== sessionRosterCacheGeneration) {
      return;
    }
    const transaction = database.transaction(SESSION_ROSTER_STORE_NAME, "readwrite");
    const completed = rosterTransactionDone(transaction);
    const store = transaction.objectStore(SESSION_ROSTER_STORE_NAME);
    const values: unknown[] = await rosterRequestResult(store.getAll());
    const next = new Map<string, SessionRosterRecord>();
    for (const value of values) {
      const record = parseSessionRosterRecord(value);
      if (!record) {
        store.clear();
        next.clear();
        break;
      }
      next.set(record.scope, record);
    }
    for (const value of records) {
      const record = boundedRecord(value);
      if (record) {
        store.put(record);
        next.set(record.scope, record);
      } else {
        store.delete(value.scope);
        next.delete(value.scope);
      }
    }
    const retained = [...next.values()].toSorted((left, right) => right.savedAt - left.savedAt);
    for (const [index, record] of retained.entries()) {
      if (index >= 6 || Date.now() - record.savedAt > SESSION_ROSTER_MAX_AGE_MS) {
        store.delete(record.scope);
      }
    }
    await completed;
  } catch {
    database.close();
    await resetSessionRosterDatabase();
  } finally {
    database.close();
  }
}

export function persistSessionRoster(record: SessionRosterRecord): void {
  if (!globalThis.indexedDB) {
    return;
  }
  pending.set(record.scope, record);
  if (timer !== null) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => void flushSessionRosters(), 500);
}

export async function flushSessionRosters(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const records = [...pending.values()];
  pending.clear();
  const generation = sessionRosterCacheGeneration;
  if (records.length > 0) {
    writeChain = writeChain.then(() => writeRecords(records, generation));
  }
  await writeChain;
}

export async function clearCachedBootState(): Promise<void> {
  invalidateSessionRosterCache();
  clearBootRecords();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  pending.clear();
  await writeChain;
  await resetSessionRosterDatabase();
}

if (
  globalThis.indexedDB &&
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function" &&
  typeof document !== "undefined" &&
  typeof document.addEventListener === "function"
) {
  window.addEventListener("pagehide", () => void flushSessionRosters());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushSessionRosters();
    }
  });
}

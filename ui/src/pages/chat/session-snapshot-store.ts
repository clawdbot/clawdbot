import { z } from "zod";
import {
  getSessionCacheValue,
  MAX_CACHED_CHAT_SESSIONS,
  setSessionCacheValue,
} from "./session-cache.ts";
import {
  MAX_CACHED_CHAT_WEIGHT,
  measureChatSnapshotWeight,
  type ChatCacheObserver,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import {
  openSessionSnapshotDatabase,
  resetSessionSnapshotDatabase,
} from "./session-snapshot-database.ts";
import {
  CHAT_SNAPSHOT_STORE_NAME,
  deleteStoredChatSnapshot,
  subscribeSnapshotInvalidation,
} from "./session-snapshot-invalidation.ts";
const MAX_STORED_ROW_HEIGHTS = 500;
const CHAT_SNAPSHOT_WRITE_DELAY_MS = 500;

const paginationSchema = z.discriminatedUnion("hasMore", [
  z
    .object({
      completeSnapshot: z.literal(true).optional(),
      hasMore: z.literal(false),
      totalMessages: z.number().finite().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      hasMore: z.literal(true),
      nextOffset: z.number().finite().nonnegative(),
      totalMessages: z.number().finite().nonnegative().optional(),
    })
    .strict(),
]);

const snapshotSchema = z
  .object({
    displayedLeafEntryId: z.string().nullable().optional(),
    messages: z.array(z.unknown()),
    pagination: paginationSchema,
    sessionId: z.string().nullable(),
  })
  .strict();

const rowHeightsSchema = z
  .map(z.string(), z.number().finite().positive())
  .refine((rowHeights) => rowHeights.size <= MAX_STORED_ROW_HEIGHTS);

const recordSchema = z
  .object({
    rowHeights: rowHeightsSchema,
    savedAt: z.number().finite().nonnegative(),
    sessionId: z.string().nullable(),
    sessionKey: z.string().min(1),
    snapshot: snapshotSchema,
  })
  .strict()
  .refine((record) => record.sessionId === record.snapshot.sessionId);

type SessionSnapshotRecord = z.infer<typeof recordSchema>;
type StoredSessionState = Pick<SessionSnapshotRecord, "rowHeights" | "snapshot">;

const activeStores = new Set<SessionSnapshotStore>();
let snapshotStoreGeneration = 0;

function debugSnapshotStore(message: string, error?: unknown): void {
  if (error === undefined) {
    console.debug(`[chat-snapshot-cache] ${message}`);
  } else {
    console.debug(`[chat-snapshot-cache] ${message}`, error);
  }
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("IndexedDB failed")),
    );
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB aborted")),
    );
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB request failed")),
    );
  });
}

function sanitizeSnapshot(snapshot: ChatSessionSnapshot): ChatSessionSnapshot | null {
  try {
    const json = JSON.stringify(snapshot);
    if (!json) {
      return null;
    }
    const parsed = snapshotSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseSnapshotRecord(value: unknown, sessionKey?: string): SessionSnapshotRecord | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success && (!sessionKey || parsed.data.sessionKey === sessionKey)
    ? parsed.data
    : null;
}

async function readSnapshotRecord(sessionKey: string): Promise<SessionSnapshotRecord | null> {
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return null;
  }
  try {
    const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readonly");
    const value = await requestResult(
      transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).get(sessionKey),
    );
    await transactionDone(transaction);
    if (value === undefined) {
      return null;
    }
    const record = parseSnapshotRecord(value, sessionKey);
    if (record) {
      return record;
    }
    debugSnapshotStore("resetting cache after record shape mismatch");
    await resetSessionSnapshotDatabase(database);
    return null;
  } catch (error) {
    debugSnapshotStore("IndexedDB read failed", error);
    await resetSessionSnapshotDatabase(database);
    return null;
  } finally {
    database.close();
  }
}

function measureStoredRecordWeight(record: SessionSnapshotRecord): number {
  const snapshotWeight = measureChatSnapshotWeight(record.snapshot) ?? 0;
  try {
    return (
      snapshotWeight +
      JSON.stringify({
        rowHeights: [...record.rowHeights],
        savedAt: record.savedAt,
        sessionId: record.sessionId,
        sessionKey: record.sessionKey,
      }).length
    );
  } catch {
    return snapshotWeight;
  }
}

async function writeSnapshotRecords(
  records: SessionSnapshotRecord[],
  generation: number,
): Promise<void> {
  if (records.length === 0 || generation !== snapshotStoreGeneration) {
    return;
  }
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return;
  }
  try {
    const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME);
    const currentValues = await requestResult(store.getAll());
    const next = new Map<string, SessionSnapshotRecord>();
    for (const value of currentValues) {
      const record = parseSnapshotRecord(value);
      if (!record) {
        transaction.abort();
        throw new Error("IndexedDB record shape mismatch");
      }
      next.set(record.sessionKey, record);
    }
    for (const record of records) {
      next.set(record.sessionKey, record);
      store.put(record);
    }
    const oldestFirst = [...next.values()].toSorted((left, right) => left.savedAt - right.savedAt);
    let totalWeight = oldestFirst.reduce(
      (sum, record) => sum + measureStoredRecordWeight(record),
      0,
    );
    while (oldestFirst.length > MAX_CACHED_CHAT_SESSIONS || totalWeight > MAX_CACHED_CHAT_WEIGHT) {
      const oldest = oldestFirst.shift();
      if (!oldest) {
        break;
      }
      totalWeight -= measureStoredRecordWeight(oldest);
      store.delete(oldest.sessionKey);
    }
    await transactionDone(transaction);
  } catch (error) {
    debugSnapshotStore("resetting cache after IndexedDB write failure", error);
    await resetSessionSnapshotDatabase(database);
  } finally {
    database.close();
  }
}

export class SessionSnapshotStore implements ChatCacheObserver {
  private connected = false;
  private readonly sessions = new Map<string, StoredSessionState>();
  private readonly pending = new Map<string, SessionSnapshotRecord>();
  private readonly revisions = new Map<string, number>();
  private writeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private writeChain = Promise.resolve();

  constructor(private readonly memoryCache?: ChatMessageCache) {}

  connect(): void {
    this.connected = true;
    activeStores.add(this);
  }

  disconnect(): void {
    this.connected = false;
    void this.flush().finally(() => {
      if (!this.connected) {
        activeStores.delete(this);
      }
    });
  }

  async read(sessionKey: string): Promise<ChatSessionSnapshot | null> {
    const generation = snapshotStoreGeneration;
    const revision = this.revisions.get(sessionKey) ?? 0;
    const record = await readSnapshotRecord(sessionKey);
    if (
      !record ||
      generation !== snapshotStoreGeneration ||
      revision !== (this.revisions.get(sessionKey) ?? 0)
    ) {
      return null;
    }
    // A network write can win while IndexedDB is pending. Keep its snapshot and
    // measurements authoritative even though the caller will discard this read.
    if (!this.sessions.has(sessionKey)) {
      setSessionCacheValue(this.sessions, sessionKey, {
        rowHeights: new Map(record.rowHeights),
        snapshot: record.snapshot,
      });
    }
    return record.snapshot;
  }

  write(sessionKey: string, snapshot: ChatSessionSnapshot): void {
    this.revisions.set(sessionKey, (this.revisions.get(sessionKey) ?? 0) + 1);
    const sanitized = sanitizeSnapshot(snapshot);
    if (!sanitized) {
      void this.delete(sessionKey);
      return;
    }
    const existing = getSessionCacheValue(this.sessions, sessionKey);
    const state = {
      rowHeights: existing?.rowHeights ?? new Map<string, number>(),
      snapshot: sanitized,
    };
    setSessionCacheValue(this.sessions, sessionKey, state);
    this.schedule(sessionKey, state);
  }

  async delete(sessionKey: string): Promise<void> {
    await deleteStoredChatSnapshot(sessionKey);
  }

  forget(sessionKey: string): void {
    this.revisions.set(sessionKey, (this.revisions.get(sessionKey) ?? 0) + 1);
    this.pending.delete(sessionKey);
    this.sessions.delete(sessionKey);
  }

  readRowHeight(sessionKey: string, rowKey: string): number | undefined {
    return getSessionCacheValue(this.sessions, sessionKey)?.rowHeights.get(rowKey);
  }

  recordRowHeight(sessionKey: string, rowKey: string, height: number): void {
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    const state = getSessionCacheValue(this.sessions, sessionKey);
    if (!state || state.rowHeights.get(rowKey) === height) {
      return;
    }
    state.rowHeights.delete(rowKey);
    state.rowHeights.set(rowKey, height);
    while (state.rowHeights.size > MAX_STORED_ROW_HEIGHTS) {
      const oldest = state.rowHeights.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      state.rowHeights.delete(oldest);
    }
    this.schedule(sessionKey, state);
  }

  async flush(): Promise<void> {
    if (this.writeTimer !== null) {
      globalThis.clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const records = [...this.pending.values()];
    this.pending.clear();
    const generation = snapshotStoreGeneration;
    this.writeChain = this.writeChain.then(() => writeSnapshotRecords(records, generation));
    await this.writeChain;
  }

  clearMemory(): void {
    if (this.writeTimer !== null) {
      globalThis.clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.pending.clear();
    this.sessions.clear();
    this.revisions.clear();
    this.memoryCache?.clear();
  }

  async whenIdle(): Promise<void> {
    await this.writeChain;
  }

  private schedule(sessionKey: string, state: StoredSessionState): void {
    this.pending.set(sessionKey, {
      rowHeights: new Map(state.rowHeights),
      savedAt: Date.now(),
      sessionId: state.snapshot.sessionId,
      sessionKey,
      snapshot: state.snapshot,
    });
    if (this.writeTimer !== null) {
      globalThis.clearTimeout(this.writeTimer);
    }
    this.writeTimer = globalThis.setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, CHAT_SNAPSHOT_WRITE_DELAY_MS);
  }
}

subscribeSnapshotInvalidation(async ({ sessionKey }) => {
  snapshotStoreGeneration += 1;
  for (const store of activeStores) {
    if (sessionKey) {
      store.forget(sessionKey);
    } else {
      store.clearMemory();
    }
  }
  await Promise.all([...activeStores].map((store) => store.whenIdle()));
});

function flushActiveStores(): void {
  for (const store of activeStores) {
    void store.flush();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushActiveStores);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushActiveStores();
    }
  });
}

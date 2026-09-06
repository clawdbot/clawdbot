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
  CHAT_SNAPSHOT_METADATA_STORE_NAME,
  CHAT_SNAPSHOT_STORE_NAME,
  openSessionSnapshotDatabase,
  resetSessionSnapshotDatabase,
} from "./session-snapshot-database.ts";
import { subscribeSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";
import { deleteStoredChatSnapshot } from "./session-snapshot-invalidation.ts";
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
    deltaCursor: z.string().optional(),
    displayedLeafEntryId: z.string().nullable().optional(),
    messages: z.array(z.unknown()),
    pagination: paginationSchema,
    sessionId: z.string().nullable(),
  })
  .strict();

const recordSchema = z
  .object({
    savedAt: z.number().finite().nonnegative(),
    sessionId: z.string().nullable(),
    sessionKey: z.string().min(1),
    snapshot: snapshotSchema,
  })
  .strict()
  .refine((record) => record.sessionId === record.snapshot.sessionId);

type SessionSnapshotRecord = z.infer<typeof recordSchema>;
const metadataSchema = z
  .object({
    savedAt: z.number().finite().nonnegative(),
    sessionKey: z.string().min(1),
    weight: z.number().finite().nonnegative(),
  })
  .strict();
type SessionSnapshotMetadata = z.infer<typeof metadataSchema>;
type PendingSessionState = {
  savedAt: number;
  snapshot: ChatSessionSnapshot;
};

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

function sanitizeSnapshot(snapshot: ChatSessionSnapshot): unknown {
  try {
    const json = JSON.stringify(snapshot);
    return json ? JSON.parse(json) : null;
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

function createSnapshotRecord(
  sessionKey: string,
  pending: PendingSessionState,
): SessionSnapshotRecord | null {
  const sanitizedSnapshot = sanitizeSnapshot(pending.snapshot);
  if (!sanitizedSnapshot) {
    return null;
  }
  const parsed = recordSchema.safeParse({
    savedAt: pending.savedAt,
    sessionId: pending.snapshot.sessionId,
    sessionKey,
    snapshot: sanitizedSnapshot,
  });
  return parsed.success ? parsed.data : null;
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

async function readSnapshotMetadata(): Promise<SessionSnapshotMetadata[] | null> {
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return [];
  }
  try {
    const transaction = database.transaction(CHAT_SNAPSHOT_METADATA_STORE_NAME, "readonly");
    const values = await requestResult(
      transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME).getAll(),
    );
    await transactionDone(transaction);
    const records: SessionSnapshotMetadata[] = [];
    for (const value of values) {
      const record = metadataSchema.safeParse(value);
      if (!record.success) {
        debugSnapshotStore("resetting cache after metadata shape mismatch");
        await resetSessionSnapshotDatabase(database);
        return null;
      }
      records.push(record.data);
    }
    return records;
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
): Promise<string[] | null> {
  if (records.length === 0 || generation !== snapshotStoreGeneration) {
    return [];
  }
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return [];
  }
  try {
    const transaction = database.transaction(
      [CHAT_SNAPSHOT_STORE_NAME, CHAT_SNAPSHOT_METADATA_STORE_NAME],
      "readwrite",
    );
    const snapshotStore = transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME);
    const metadataStore = transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME);
    const currentValues = await requestResult(metadataStore.getAll());
    const next = new Map<string, SessionSnapshotMetadata>();
    for (const value of currentValues) {
      const metadata = metadataSchema.safeParse(value);
      if (!metadata.success) {
        transaction.abort();
        throw new Error("IndexedDB metadata shape mismatch");
      }
      next.set(metadata.data.sessionKey, metadata.data);
    }
    for (const record of records) {
      const metadata = {
        savedAt: record.savedAt,
        sessionKey: record.sessionKey,
        weight: measureStoredRecordWeight(record),
      } satisfies SessionSnapshotMetadata;
      next.set(record.sessionKey, metadata);
      snapshotStore.put(record);
      metadataStore.put(metadata);
    }
    const oldestFirst = [...next.values()].toSorted((left, right) => left.savedAt - right.savedAt);
    let totalWeight = oldestFirst.reduce((sum, metadata) => sum + metadata.weight, 0);
    const evicted: string[] = [];
    while (oldestFirst.length > MAX_CACHED_CHAT_SESSIONS || totalWeight > MAX_CACHED_CHAT_WEIGHT) {
      const oldest = oldestFirst.shift();
      if (!oldest) {
        break;
      }
      totalWeight -= oldest.weight;
      snapshotStore.delete(oldest.sessionKey);
      metadataStore.delete(oldest.sessionKey);
      evicted.push(oldest.sessionKey);
    }
    await transactionDone(transaction);
    return evicted;
  } catch (error) {
    debugSnapshotStore("resetting cache after IndexedDB write failure", error);
    await resetSessionSnapshotDatabase(database);
    return null;
  } finally {
    database.close();
  }
}

export class SessionSnapshotStore implements ChatCacheObserver {
  private connected = false;
  private readonly pending = new Map<string, PendingSessionState>();
  // Hydration identity suppresses unchanged writes; the bounded message cache
  // owns transcript retention, so eviction must leave no second strong owner.
  private readonly hydratedSnapshots = new Map<string, WeakRef<ChatSessionSnapshot>>();
  private readonly revisions = new Map<string, number>();
  // Cross-tab writes may leave this index stale until reload; the 30s prefetch
  // cooldown bounds the resulting redundant fetches without per-row IDB reads.
  private readonly savedAtBySession = new Map<string, number>();
  private savedAtSeed: Promise<void> | null = null;
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

  captureReadScope(sessionKey: string): () => boolean {
    const generation = snapshotStoreGeneration;
    const revision = this.revisions.get(sessionKey) ?? 0;
    return () =>
      generation === snapshotStoreGeneration && revision === (this.revisions.get(sessionKey) ?? 0);
  }

  async read(sessionKey: string): Promise<ChatSessionSnapshot | null> {
    const isCurrent = this.captureReadScope(sessionKey);
    const record = await readSnapshotRecord(sessionKey);
    if (!record || !isCurrent()) {
      return null;
    }
    setSessionCacheValue(this.hydratedSnapshots, sessionKey, new WeakRef(record.snapshot));
    return record.snapshot;
  }

  async loadSavedAtIndex(): Promise<void> {
    this.savedAtSeed ??= this.seedSavedAtIndex();
    await this.savedAtSeed;
  }

  readSavedAt(sessionKey: string): number | null {
    return this.pending.get(sessionKey)?.savedAt ?? this.savedAtBySession.get(sessionKey) ?? null;
  }

  write(sessionKey: string, snapshot: ChatSessionSnapshot): void {
    this.revisions.set(sessionKey, (this.revisions.get(sessionKey) ?? 0) + 1);
    if (getSessionCacheValue(this.hydratedSnapshots, sessionKey)?.deref() === snapshot) {
      return;
    }
    this.hydratedSnapshots.delete(sessionKey);
    // Cache reconciliation replaces snapshots immutably, so retaining this raw
    // reference until the debounced flush cannot observe in-place mutation.
    this.schedule(sessionKey, snapshot);
  }

  async delete(sessionKey: string): Promise<void> {
    this.forget(sessionKey);
    await deleteStoredChatSnapshot(sessionKey);
  }

  forget(sessionKey: string): void {
    this.revisions.set(sessionKey, (this.revisions.get(sessionKey) ?? 0) + 1);
    this.pending.delete(sessionKey);
    this.hydratedSnapshots.delete(sessionKey);
    this.savedAtBySession.delete(sessionKey);
    this.memoryCache?.delete(sessionKey);
  }

  async flush(): Promise<void> {
    if (this.writeTimer !== null) {
      globalThis.clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const pending = [...this.pending.entries()];
    const pendingRevisions = new Map(
      pending.map(([sessionKey]) => [sessionKey, this.revisions.get(sessionKey) ?? 0]),
    );
    this.pending.clear();
    const records: SessionSnapshotRecord[] = [];
    for (const [sessionKey, state] of pending) {
      const record = createSnapshotRecord(sessionKey, state);
      if (record) {
        records.push(record);
      } else {
        await this.delete(sessionKey);
      }
    }
    const generation = snapshotStoreGeneration;
    this.writeChain = this.writeChain.then(async () => {
      const currentRecords = records.filter(
        ({ sessionKey }) =>
          pendingRevisions.get(sessionKey) === (this.revisions.get(sessionKey) ?? 0),
      );
      const evicted = await writeSnapshotRecords(currentRecords, generation);
      if (evicted === null) {
        this.resetSavedAtIndex();
        return;
      }
      for (const sessionKey of evicted) {
        if (!this.pending.has(sessionKey)) {
          this.savedAtBySession.delete(sessionKey);
        }
      }
    });
    await this.writeChain;
  }

  clearMemory(): void {
    if (this.writeTimer !== null) {
      globalThis.clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.pending.clear();
    this.hydratedSnapshots.clear();
    this.revisions.clear();
    this.savedAtBySession.clear();
    this.memoryCache?.clear();
  }

  async whenIdle(): Promise<void> {
    await this.writeChain;
  }

  private schedule(sessionKey: string, snapshot: ChatSessionSnapshot): void {
    const pending = {
      savedAt: Date.now(),
      snapshot,
    };
    this.pending.set(sessionKey, pending);
    this.savedAtBySession.set(sessionKey, pending.savedAt);
    if (this.writeTimer !== null) {
      globalThis.clearTimeout(this.writeTimer);
    }
    this.writeTimer = globalThis.setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, CHAT_SNAPSHOT_WRITE_DELAY_MS);
  }

  private async seedSavedAtIndex(): Promise<void> {
    const generation = snapshotStoreGeneration;
    const revisions = new Map(this.revisions);
    const records = await readSnapshotMetadata();
    if (generation !== snapshotStoreGeneration) {
      return;
    }
    if (!records) {
      this.resetSavedAtIndex();
      return;
    }
    for (const record of records) {
      if (
        (revisions.get(record.sessionKey) ?? 0) !== (this.revisions.get(record.sessionKey) ?? 0)
      ) {
        continue;
      }
      const current = this.savedAtBySession.get(record.sessionKey) ?? 0;
      this.savedAtBySession.set(record.sessionKey, Math.max(current, record.savedAt));
    }
  }

  private resetSavedAtIndex(): void {
    this.savedAtBySession.clear();
    for (const [sessionKey, pending] of this.pending) {
      this.savedAtBySession.set(sessionKey, pending.savedAt);
    }
  }
}

subscribeSnapshotInvalidation(async ({ sessionKey }) => {
  // Scoped deletes fence only their session; whole-cache clears retire every pending operation.
  if (!sessionKey) {
    snapshotStoreGeneration += 1;
  }
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

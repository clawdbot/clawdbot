// Matrix plugin module implements SQLite sync cache behavior.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  Category,
  MemoryStore,
  SyncAccumulator,
  type ISyncData,
  type IRooms,
  type ISyncResponse,
  type IStoredClientOpts,
} from "matrix-js-sdk/lib/matrix.js";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "../../record-shared.js";
import { getMatrixRuntime } from "../../runtime.js";
import { createAsyncLock } from "../async-lock.js";
import { LogService } from "../sdk/logger.js";
import { resolveMatrixSqliteStateEnv } from "../sqlite-state.js";
import { claimCurrentTokenStorageState } from "./storage.js";

const STORE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 250;
const SYNC_CACHE_NAMESPACE = "sync-cache";
const SYNC_CACHE_MAX_ENTRIES = 20_000;
const SYNC_CACHE_MAX_CHUNKS = Math.floor((SYNC_CACHE_MAX_ENTRIES - 1) / 2);
const SYNC_CACHE_STATE_KEY = "current";
// PluginState serializes this string inside a row object; 24KB leaves room for JSON escaping.
const SYNC_CACHE_CHUNK_BYTES = 24_000;

export type PersistedMatrixSyncStore = {
  version: number;
  savedSync: ISyncData | null;
  clientOptions?: IStoredClientOpts;
  cleanShutdown?: boolean;
};

type MatrixSyncCacheMeta = {
  kind: "meta";
  version: number;
  generation: string;
  chunkCount: number;
  syncDigest?: string;
  clientOptions?: IStoredClientOpts;
  cleanShutdown?: boolean;
};

type MatrixSyncCacheChunk = {
  kind: "sync-chunk";
  index: number;
  data: string;
};

export type MatrixSyncCacheRecord = MatrixSyncCacheMeta | MatrixSyncCacheChunk;

type MatrixSyncCacheAsyncStore = Pick<
  PluginStateKeyedStore<MatrixSyncCacheRecord>,
  "delete" | "entries" | "lookup" | "register"
>;

function normalizeRoomsData(value: unknown): IRooms | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    [Category.Join]: isRecord(value[Category.Join]) ? (value[Category.Join] as IRooms["join"]) : {},
    [Category.Invite]: isRecord(value[Category.Invite])
      ? (value[Category.Invite] as IRooms["invite"])
      : {},
    [Category.Leave]: isRecord(value[Category.Leave])
      ? (value[Category.Leave] as IRooms["leave"])
      : {},
    [Category.Knock]: isRecord(value[Category.Knock])
      ? (value[Category.Knock] as IRooms["knock"])
      : {},
  };
}

function toPersistedSyncData(value: unknown): ISyncData | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.nextBatch === "string" && value.nextBatch.trim()) {
    const roomsData = normalizeRoomsData(value.roomsData);
    if (!Array.isArray(value.accountData) || !roomsData) {
      return null;
    }
    return {
      nextBatch: value.nextBatch,
      accountData: value.accountData,
      roomsData,
    };
  }

  // Older Matrix state files stored the raw /sync-shaped payload directly.
  if (typeof value.next_batch === "string" && value.next_batch.trim()) {
    const roomsData = normalizeRoomsData(value.rooms);
    if (!roomsData) {
      return null;
    }
    return {
      nextBatch: value.next_batch,
      accountData:
        isRecord(value.account_data) && Array.isArray(value.account_data.events)
          ? value.account_data.events
          : [],
      roomsData,
    };
  }

  return null;
}

function normalizePersistedStore(value: unknown): PersistedMatrixSyncStore | null {
  if (!isRecord(value) || value.version !== STORE_VERSION) {
    return null;
  }
  return {
    version: STORE_VERSION,
    savedSync: toPersistedSyncData(value.savedSync),
    clientOptions: isRecord(value.clientOptions)
      ? (value.clientOptions as IStoredClientOpts)
      : undefined,
    cleanShutdown: value.cleanShutdown === true,
  };
}

function normalizeLegacyPersistedStore(value: unknown): PersistedMatrixSyncStore | null {
  const persisted = normalizePersistedStore(value);
  if (persisted) {
    return persisted;
  }
  return {
    version: STORE_VERSION,
    savedSync: toPersistedSyncData(value),
    cleanShutdown: false,
  };
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function syncDataToSyncResponse(syncData: ISyncData): ISyncResponse {
  return {
    next_batch: syncData.nextBatch,
    rooms: syncData.roomsData,
    account_data: {
      events: syncData.accountData,
    },
  };
}

export class SqliteBackedMatrixSyncStore extends MemoryStore {
  private readonly persistLock = createAsyncLock();
  private readonly accumulator = new SyncAccumulator();
  private readonly stateKey: string;
  private readonly store: PluginStateSyncKeyedStore<MatrixSyncCacheRecord>;
  private readonly storeUnavailableError: unknown;
  private savedSync: ISyncData | null = null;
  private savedClientOptions: IStoredClientOpts | undefined;
  private readonly hadSavedSyncOnLoad: boolean;
  private readonly hadCleanShutdownOnLoad: boolean;
  private cleanShutdown = false;
  private dirty = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistPromise: Promise<void> | null = null;

  constructor(private readonly storageRootDir: string) {
    super();
    this.stateKey = resolveSyncCacheStateKey(storageRootDir);

    let restoredSavedSync: ISyncData | null = null;
    let restoredClientOptions: IStoredClientOpts | undefined;
    let restoredCleanShutdown = false;
    let syncCacheStore = createNoopMatrixSyncCacheStore();
    let syncCacheStoreUnavailableError: unknown;
    try {
      syncCacheStore = openMatrixSyncCacheStore(storageRootDir);
      const persisted = readPersistedStoreFromSyncStore(syncCacheStore, this.stateKey);
      if (persisted) {
        restoredSavedSync = persisted.savedSync;
        restoredClientOptions = persisted.clientOptions;
        restoredCleanShutdown = persisted.cleanShutdown === true;
      }
    } catch (err) {
      syncCacheStoreUnavailableError = err;
      LogService.warn("MatrixSyncCacheStore", "Failed to load Matrix sync cache:", err);
    }
    this.store = syncCacheStore;
    this.storeUnavailableError = syncCacheStoreUnavailableError;

    this.savedSync = restoredSavedSync;
    this.savedClientOptions = restoredClientOptions;
    this.hadSavedSyncOnLoad = restoredSavedSync !== null;
    this.hadCleanShutdownOnLoad = this.hadSavedSyncOnLoad && restoredCleanShutdown;
    this.cleanShutdown = this.hadCleanShutdownOnLoad;

    if (this.savedSync) {
      this.accumulator.accumulate(syncDataToSyncResponse(this.savedSync), true);
      super.setSyncToken(this.savedSync.nextBatch);
    }
    if (this.savedClientOptions) {
      void super.storeClientOptions(this.savedClientOptions);
    }
  }

  hasSavedSync(): boolean {
    return this.hadSavedSyncOnLoad;
  }

  hasSavedSyncFromCleanShutdown(): boolean {
    return this.hadCleanShutdownOnLoad;
  }

  override getSavedSync(): Promise<ISyncData | null> {
    return Promise.resolve(this.savedSync ? cloneJson(this.savedSync) : null);
  }

  override getSavedSyncToken(): Promise<string | null> {
    return Promise.resolve(this.savedSync?.nextBatch ?? null);
  }

  override setSyncData(syncData: ISyncResponse): Promise<void> {
    this.accumulator.accumulate(syncData);
    this.savedSync = this.accumulator.getJSON();
    this.markDirtyAndSchedulePersist();
    return Promise.resolve();
  }

  override getClientOptions() {
    return Promise.resolve(
      this.savedClientOptions ? cloneJson(this.savedClientOptions) : undefined,
    );
  }

  override storeClientOptions(options: IStoredClientOpts) {
    this.savedClientOptions = cloneJson(options);
    void super.storeClientOptions(options);
    this.markDirtyAndSchedulePersist();
    return Promise.resolve();
  }

  override save(force = false) {
    if (force) {
      return this.flush();
    }
    return Promise.resolve();
  }

  override wantsSave(): boolean {
    // We persist directly from setSyncData/storeClientOptions so the SDK's
    // periodic save hook stays disabled. Shutdown uses flush() for a final sync.
    return false;
  }

  override async deleteAllData(): Promise<void> {
    this.assertStoreAvailable();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = false;
    await this.persistPromise?.catch(() => undefined);
    await super.deleteAllData();
    this.savedSync = null;
    this.savedClientOptions = undefined;
    this.cleanShutdown = false;
    this.store.delete(metaKey(this.stateKey));
    for (const row of this.store.entries()) {
      if (row.key.startsWith(chunkKeyPrefix(this.stateKey))) {
        this.store.delete(row.key);
      }
    }
    await fs
      .rm(resolveLegacySyncCachePath(this.storageRootDir), { force: true })
      .catch(() => undefined);
  }

  markCleanShutdown(): void {
    this.cleanShutdown = true;
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    while (this.dirty || this.persistPromise) {
      if (this.dirty && !this.persistPromise) {
        this.persistPromise = this.persist().finally(() => {
          this.persistPromise = null;
        });
      }
      await this.persistPromise;
    }
  }

  private markDirtyAndSchedulePersist(): void {
    this.cleanShutdown = false;
    this.dirty = true;
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush().catch((err: unknown) => {
        LogService.warn("MatrixSyncCacheStore", "Failed to persist Matrix sync store:", err);
      });
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private async persist(): Promise<void> {
    this.assertStoreAvailable();
    this.dirty = false;
    const payload: PersistedMatrixSyncStore = {
      version: STORE_VERSION,
      savedSync: this.savedSync ? cloneJson(this.savedSync) : null,
      cleanShutdown: this.cleanShutdown,
      ...(this.savedClientOptions ? { clientOptions: cloneJson(this.savedClientOptions) } : {}),
    };
    try {
      await this.persistLock(async () => {
        this.writePersistedStore(payload);
        claimCurrentTokenStorageState({
          rootDir: this.storageRootDir,
        });
      });
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }

  private writePersistedStore(payload: PersistedMatrixSyncStore): void {
    const rows = buildSyncCacheRows(this.stateKey, payload);
    for (const row of rows.chunks) {
      this.store.register(row.key, row.value);
    }
    this.store.register(rows.meta.key, rows.meta.value);
    for (const row of this.store.entries()) {
      if (row.key.startsWith(chunkKeyPrefix(this.stateKey)) && !rows.nextChunkKeys.has(row.key)) {
        this.store.delete(row.key);
      }
    }
  }

  private assertStoreAvailable(): void {
    if (this.storeUnavailableError == null) {
      return;
    }
    throw new Error("Matrix sync cache SQLite store is unavailable; cannot persist sync state", {
      cause: this.storeUnavailableError,
    });
  }
}

function createNoopMatrixSyncCacheStore(): PluginStateSyncKeyedStore<MatrixSyncCacheRecord> {
  return {
    register: () => {},
    registerIfAbsent: () => false,
    lookup: () => undefined,
    consume: () => undefined,
    delete: () => false,
    entries: () => [],
    clear: () => {},
  };
}

function readPersistedStoreFromSyncStore(
  store: PluginStateSyncKeyedStore<MatrixSyncCacheRecord>,
  stateKey: string,
): PersistedMatrixSyncStore | null {
  const meta = store.lookup(metaKey(stateKey));
  if (!isSyncCacheMeta(meta)) {
    return null;
  }
  const chunks: string[] = [];
  for (let index = 0; index < meta.chunkCount; index += 1) {
    const chunk = store.lookup(chunkKey(stateKey, meta.generation, index));
    if (!isSyncCacheChunk(chunk) || chunk.index !== index) {
      return normalizePersistedStore({
        version: STORE_VERSION,
        savedSync: null,
        clientOptions: meta.clientOptions,
        cleanShutdown: false,
      });
    }
    chunks.push(chunk.data);
  }
  let savedSync: ISyncData | null = null;
  if (chunks.length > 0) {
    const syncJson = chunks.join("");
    if (meta.syncDigest !== digestText(syncJson)) {
      return normalizePersistedStore({
        version: STORE_VERSION,
        savedSync: null,
        clientOptions: meta.clientOptions,
        cleanShutdown: false,
      });
    }
    try {
      savedSync = toPersistedSyncData(JSON.parse(syncJson));
    } catch {
      savedSync = null;
    }
  }
  return normalizePersistedStore({
    version: STORE_VERSION,
    savedSync,
    clientOptions: meta.clientOptions,
    cleanShutdown: meta.cleanShutdown,
  });
}

function openMatrixSyncCacheStore(
  storageRootDir: string,
): PluginStateSyncKeyedStore<MatrixSyncCacheRecord> {
  return getMatrixRuntime().state.openSyncKeyedStore<MatrixSyncCacheRecord>(
    openMatrixSyncCacheStoreOptions(storageRootDir),
  );
}

function resolveSyncCacheStateKey(_storageRootDir: string): string {
  return SYNC_CACHE_STATE_KEY;
}

function metaKey(stateKey: string): string {
  return `${stateKey}:meta`;
}

function chunkKeyPrefix(stateKey: string): string {
  return `${stateKey}:sync:`;
}

function chunkKey(stateKey: string, generation: string, index: number): string {
  return `${chunkKeyPrefix(stateKey)}${generation}:${index}`;
}

function resolveLegacySyncCachePath(storageRootDir: string): string {
  return path.join(storageRootDir, "bot-storage.json");
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isSyncCacheMeta(value: unknown): value is MatrixSyncCacheMeta {
  return (
    isRecord(value) &&
    value.kind === "meta" &&
    value.version === STORE_VERSION &&
    typeof value.generation === "string" &&
    value.generation.trim() !== "" &&
    typeof value.chunkCount === "number" &&
    Number.isSafeInteger(value.chunkCount) &&
    value.chunkCount >= 0 &&
    value.chunkCount <= SYNC_CACHE_MAX_CHUNKS
  );
}

function isSyncCacheChunk(value: unknown): value is MatrixSyncCacheChunk {
  return (
    isRecord(value) &&
    value.kind === "sync-chunk" &&
    typeof value.index === "number" &&
    Number.isSafeInteger(value.index) &&
    value.index >= 0 &&
    typeof value.data === "string"
  );
}

function chunkSyncCacheJson(value: string): string[] {
  const chunks: string[] = [];
  const pushChunk = (chunk: string) => {
    if (chunks.length >= SYNC_CACHE_MAX_CHUNKS) {
      throw new Error("Matrix sync cache exceeds SQLite chunk limit");
    }
    chunks.push(chunk);
  };
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && currentBytes + charBytes > SYNC_CACHE_CHUNK_BYTES) {
      pushChunk(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) {
    pushChunk(current);
  }
  return chunks;
}

function buildSyncCacheRows(
  stateKey: string,
  payload: PersistedMatrixSyncStore,
): {
  meta: { key: string; value: MatrixSyncCacheMeta };
  chunks: { key: string; value: MatrixSyncCacheChunk }[];
  nextChunkKeys: Set<string>;
} {
  const generation = randomUUID().replaceAll("-", "");
  const syncJson = payload.savedSync ? JSON.stringify(payload.savedSync) : "";
  const chunkValues = syncJson ? chunkSyncCacheJson(syncJson) : [];
  const chunks = chunkValues.map((data, index) => ({
    key: chunkKey(stateKey, generation, index),
    value: {
      kind: "sync-chunk" as const,
      index,
      data,
    },
  }));
  return {
    chunks,
    nextChunkKeys: new Set(chunks.map((chunk) => chunk.key)),
    meta: {
      key: metaKey(stateKey),
      value: {
        kind: "meta",
        version: STORE_VERSION,
        generation,
        chunkCount: chunks.length,
        ...(syncJson ? { syncDigest: digestText(syncJson) } : {}),
        ...(payload.clientOptions ? { clientOptions: payload.clientOptions } : {}),
        cleanShutdown: payload.cleanShutdown === true,
      },
    },
  };
}

export async function readLegacyMatrixSyncCacheState(
  storageRootDir: string,
): Promise<PersistedMatrixSyncStore | null> {
  try {
    const raw = await fs.readFile(resolveLegacySyncCachePath(storageRootDir), "utf8");
    const persisted = normalizeLegacyPersistedStore(JSON.parse(raw));
    if (!persisted?.savedSync && !persisted?.clientOptions) {
      return null;
    }
    return persisted;
  } catch {
    return null;
  }
}

export async function hasMatrixSyncCacheStateInStore(params: {
  storageRootDir: string;
  store: Pick<PluginStateKeyedStore<MatrixSyncCacheRecord>, "lookup">;
}): Promise<boolean> {
  const stateKey = resolveSyncCacheStateKey(params.storageRootDir);
  const meta = await params.store.lookup(metaKey(stateKey));
  if (!isSyncCacheMeta(meta) || meta.chunkCount <= 0) {
    return false;
  }
  const chunks: string[] = [];
  for (let index = 0; index < meta.chunkCount; index += 1) {
    const chunk = await params.store.lookup(chunkKey(stateKey, meta.generation, index));
    if (!isSyncCacheChunk(chunk) || chunk.index !== index) {
      return false;
    }
    chunks.push(chunk.data);
  }
  const syncJson = chunks.join("");
  if (meta.syncDigest !== digestText(syncJson)) {
    return false;
  }
  try {
    return toPersistedSyncData(JSON.parse(syncJson)) !== null;
  } catch {
    return false;
  }
}

export async function writeMatrixSyncCacheStateToStore(params: {
  storageRootDir: string;
  payload: PersistedMatrixSyncStore;
  store: MatrixSyncCacheAsyncStore;
}): Promise<void> {
  const stateKey = resolveSyncCacheStateKey(params.storageRootDir);
  const rows = buildSyncCacheRows(stateKey, params.payload);
  for (const row of rows.chunks) {
    await params.store.register(row.key, row.value);
  }
  await params.store.register(rows.meta.key, rows.meta.value);
  for (const row of await params.store.entries()) {
    if (row.key.startsWith(chunkKeyPrefix(stateKey)) && !rows.nextChunkKeys.has(row.key)) {
      await params.store.delete(row.key);
    }
  }
}

export function openMatrixSyncCacheStoreOptions(storageRootDir: string) {
  return {
    namespace: SYNC_CACHE_NAMESPACE,
    maxEntries: SYNC_CACHE_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv({ stateDir: storageRootDir }),
  };
}

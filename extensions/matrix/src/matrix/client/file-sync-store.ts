// Matrix plugin module implements the live SDK's SQLite sync store.
import {
  MemoryStore,
  SyncAccumulator,
  type ISyncData,
  type ISyncResponse,
  type IStoredClientOpts,
} from "matrix-js-sdk/lib/matrix.js";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import { createAsyncLock } from "../async-lock.js";
import { LogService } from "../sdk/logger.js";
import { claimCurrentTokenStorageState } from "./storage.js";
import {
  MATRIX_SYNC_CACHE_VERSION,
  deleteMatrixSyncCacheStateFromSyncStore,
  openMatrixSyncCacheStoreOptions,
  readPersistedStoreFromSyncStore,
  writeMatrixSyncCacheStateToSyncStore,
  type MatrixSyncCacheRecord,
  type PersistedMatrixSyncStore,
} from "./sync-cache-state.js";

const PERSIST_DEBOUNCE_MS = 250;

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
  private readonly store: PluginStateSyncKeyedStore<MatrixSyncCacheRecord>;
  private readonly storeUnavailableError: unknown;
  private savedSync: ISyncData | null = null;
  private savedClientOptions: IStoredClientOpts | undefined;
  private readonly hadSavedSyncOnLoad: boolean;
  private readonly hadCleanShutdownOnLoad: boolean;
  private cleanShutdown = false;
  private dirty = false;
  private frozen = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistPromise: Promise<void> | null = null;

  constructor(private readonly storageRootDir: string) {
    super();

    let restoredSavedSync: ISyncData | null = null;
    let restoredClientOptions: IStoredClientOpts | undefined;
    let restoredCleanShutdown = false;
    let syncCacheStore = createNoopMatrixSyncCacheStore();
    let syncCacheStoreUnavailableError: unknown;
    try {
      syncCacheStore = openMatrixSyncCacheStore(storageRootDir);
      const persisted = readPersistedStoreFromSyncStore(syncCacheStore);
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
    if (this.frozen) {
      return Promise.resolve();
    }
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
    if (this.frozen) {
      return Promise.resolve();
    }
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
    await deleteMatrixSyncCacheStateFromSyncStore({
      storageRootDir: this.storageRootDir,
      store: this.store,
    });
  }

  markCleanShutdown(): void {
    this.cleanShutdown = true;
    this.dirty = true;
  }

  async freezeSyncCursorPersistence(): Promise<void> {
    this.frozen = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persistPromise;
  }

  discardPendingSyncCursorPersistence(): void {
    this.frozen = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.cleanShutdown = false;
    this.dirty = false;
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
    if (this.frozen) {
      return;
    }
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
      version: MATRIX_SYNC_CACHE_VERSION,
      savedSync: this.savedSync ? cloneJson(this.savedSync) : null,
      cleanShutdown: this.cleanShutdown,
      ...(this.savedClientOptions ? { clientOptions: cloneJson(this.savedClientOptions) } : {}),
    };
    try {
      await this.persistLock(async () => {
        writeMatrixSyncCacheStateToSyncStore({ payload, store: this.store });
        claimCurrentTokenStorageState({
          rootDir: this.storageRootDir,
        });
      });
    } catch (err) {
      this.dirty = true;
      throw err;
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
    lookupMany: (keys) => keys.map(() => ({ ok: true, value: undefined })),
    consume: () => undefined,
    delete: () => false,
    entries: () => [],
    clear: () => {},
  };
}

function openMatrixSyncCacheStore(
  storageRootDir: string,
): PluginStateSyncKeyedStore<MatrixSyncCacheRecord> {
  return getMatrixRuntime().state.openSyncKeyedStore<MatrixSyncCacheRecord>(
    openMatrixSyncCacheStoreOptions(storageRootDir),
  );
}

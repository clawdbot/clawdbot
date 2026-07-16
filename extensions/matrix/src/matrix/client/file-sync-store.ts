import { readFileSync } from "node:fs";
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
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { isRecord } from "../../record-shared.js";
import { createAsyncLock } from "../async-lock.js";
import { LogService } from "../sdk/logger.js";
import { claimCurrentTokenStorageState } from "./storage.js";

const STORE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 250;

type PersistedMatrixSyncStore = {
  version: number;
  savedSync: ISyncData | null;
  clientOptions?: IStoredClientOpts;
  cleanShutdown?: boolean;
};

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

function readPersistedStore(raw: string): PersistedMatrixSyncStore | null {
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      savedSync?: unknown;
      clientOptions?: unknown;
      cleanShutdown?: unknown;
    };
    const savedSync = toPersistedSyncData(parsed.savedSync);
    if (parsed.version === STORE_VERSION) {
      return {
        version: STORE_VERSION,
        savedSync,
        clientOptions: isRecord(parsed.clientOptions)
          ? (parsed.clientOptions as IStoredClientOpts)
          : undefined,
        cleanShutdown: parsed.cleanShutdown === true,
      };
    }

    // Backward-compat: prior Matrix state files stored the raw sync blob at the
    // top level without versioning or wrapped metadata.
    return {
      version: STORE_VERSION,
      savedSync: toPersistedSyncData(parsed),
      cleanShutdown: false,
    };
  } catch {
    return null;
  }
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

export class FileBackedMatrixSyncStore extends MemoryStore {
  private readonly persistLock = createAsyncLock();
  private readonly accumulator = new SyncAccumulator();
  private savedSync: ISyncData | null = null;
  private savedClientOptions: IStoredClientOpts | undefined;
  private readonly hadSavedSyncOnLoad: boolean;
  private readonly hadCleanShutdownOnLoad: boolean;
  private cleanShutdown = false;
  private dirty = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistPromise: Promise<void> | null = null;

  constructor(private readonly storagePath: string) {
    super();

    let restoredSavedSync: ISyncData | null = null;
    let restoredClientOptions: IStoredClientOpts | undefined;
    let restoredCleanShutdown = false;
    try {
      const raw = readFileSync(this.storagePath, "utf8");
      const persisted = readPersistedStore(raw);
      restoredSavedSync = persisted?.savedSync ?? null;
      restoredClientOptions = persisted?.clientOptions;
      restoredCleanShutdown = persisted?.cleanShutdown === true;
    } catch {
      // Missing or unreadable sync cache should not block startup.
    }

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
    await fs.rm(this.storagePath, { force: true }).catch(() => undefined);
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
      void this.flush().catch((err) => {
        LogService.warn("MatrixFileSyncStore", "Failed to persist Matrix sync store:", err);
      });
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private async persist(): Promise<void> {
    this.dirty = false;
    const payload: PersistedMatrixSyncStore = {
      version: STORE_VERSION,
      savedSync: this.savedSync ? cloneJson(this.savedSync) : null,
      cleanShutdown: this.cleanShutdown,
      ...(this.savedClientOptions ? { clientOptions: cloneJson(this.savedClientOptions) } : {}),
    };
    try {
      await this.persistLock(async () => {
        await writeJsonFileAtomically(this.storagePath, payload);
        claimCurrentTokenStorageState({
          rootDir: path.dirname(this.storagePath),
        });
      });
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }
}

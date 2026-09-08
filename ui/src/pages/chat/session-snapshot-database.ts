export const CHAT_SNAPSHOT_DB_NAME = "openclaw-chat-snapshots";
export const CHAT_SNAPSHOT_STORE_NAME = "snapshots";
export const CHAT_SNAPSHOT_METADATA_STORE_NAME = "snapshotMetadata";
const CHAT_SNAPSHOT_DB_VERSION = 2;

function debugSnapshotDatabase(message: string, error?: unknown): void {
  if (error === undefined) {
    console.debug(`[chat-snapshot-cache] ${message}`);
  } else {
    console.debug(`[chat-snapshot-cache] ${message}`, error);
  }
}

function indexedDbFactory(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch (error) {
    debugSnapshotDatabase("IndexedDB is unavailable", error);
    return null;
  }
}

function openIndexedDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(CHAT_SNAPSHOT_DB_NAME, CHAT_SNAPSHOT_DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      for (const name of Array.from(database.objectStoreNames)) {
        database.deleteObjectStore(name);
      }
      database.createObjectStore(CHAT_SNAPSHOT_STORE_NAME, { keyPath: "sessionKey" });
      database.createObjectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME, { keyPath: "sessionKey" });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB open failed")),
    );
    request.addEventListener("blocked", () => reject(new Error("IndexedDB open was blocked")));
  });
}

function deleteIndexedDb(factory: IDBFactory): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = factory.deleteDatabase(CHAT_SNAPSHOT_DB_NAME);
      request.addEventListener("success", () => resolve(true));
      request.addEventListener("error", () => resolve(false));
      request.addEventListener("blocked", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

export async function openSessionSnapshotDatabase(): Promise<IDBDatabase | null> {
  const factory = indexedDbFactory();
  if (!factory) {
    return null;
  }
  let database: IDBDatabase;
  try {
    database = await openIndexedDb(factory);
  } catch (error) {
    debugSnapshotDatabase("resetting cache after IndexedDB open failure", error);
    if (!(await deleteIndexedDb(factory))) {
      return null;
    }
    try {
      database = await openIndexedDb(factory);
    } catch (retryError) {
      debugSnapshotDatabase("IndexedDB cache remains unavailable", retryError);
      return null;
    }
  }
  database.addEventListener("versionchange", () => database.close());
  if (
    database.objectStoreNames.length === 2 &&
    database.objectStoreNames.contains(CHAT_SNAPSHOT_STORE_NAME) &&
    database.objectStoreNames.contains(CHAT_SNAPSHOT_METADATA_STORE_NAME)
  ) {
    return database;
  }
  database.close();
  debugSnapshotDatabase("resetting cache after IndexedDB schema mismatch");
  if (!(await deleteIndexedDb(factory))) {
    return null;
  }
  try {
    const fresh = await openIndexedDb(factory);
    fresh.addEventListener("versionchange", () => fresh.close());
    return fresh;
  } catch (error) {
    debugSnapshotDatabase("IndexedDB cache reset failed", error);
    return null;
  }
}

export async function readStoredChatSnapshotRecord(sessionKey: string): Promise<unknown> {
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return undefined;
  }
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(CHAT_SNAPSHOT_STORE_NAME, "readonly");
      const request = transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).get(sessionKey);
      transaction.addEventListener("complete", () => resolve(request.result));
      transaction.addEventListener("error", () =>
        reject(transaction.error ?? new Error("IndexedDB read failed")),
      );
      transaction.addEventListener("abort", () =>
        reject(transaction.error ?? new Error("IndexedDB read aborted")),
      );
    });
  } catch (error) {
    debugSnapshotDatabase("resetting cache after IndexedDB read failure", error);
    await resetSessionSnapshotDatabase(database);
    return undefined;
  } finally {
    database.close();
  }
}

export async function resetSessionSnapshotDatabase(database?: IDBDatabase | null): Promise<void> {
  database?.close();
  const factory = indexedDbFactory();
  if (factory && !(await deleteIndexedDb(factory))) {
    debugSnapshotDatabase("IndexedDB cache reset was blocked");
  }
}

export async function deleteSessionSnapshotDatabaseRecord(sessionKey: string): Promise<void> {
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return;
  }
  try {
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(
        [CHAT_SNAPSHOT_STORE_NAME, CHAT_SNAPSHOT_METADATA_STORE_NAME],
        "readwrite",
      );
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => resolve());
      transaction.addEventListener("abort", () => resolve());
      transaction.objectStore(CHAT_SNAPSHOT_STORE_NAME).delete(sessionKey);
      transaction.objectStore(CHAT_SNAPSHOT_METADATA_STORE_NAME).delete(sessionKey);
    });
  } catch {
  } finally {
    database.close();
  }
}

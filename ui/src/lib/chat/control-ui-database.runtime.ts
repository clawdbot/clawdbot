const DATABASE_NAME = "openclaw-control-ui";
const DATABASE_VERSION = 2;
const STORE_NAME = "composerDrafts";
const OWNER_INDEX = "ownerKey";
let databasePromise: Promise<IDBDatabase> | null = null;

function indexedDbError(error: DOMException | null, message: string): Error {
  return error ?? new Error(message);
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(indexedDbError(request.error, "IndexedDB request failed")),
      { once: true },
    );
  });
}

export function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(indexedDbError(transaction.error, "IndexedDB transaction aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(indexedDbError(transaction.error, "IndexedDB transaction failed")),
      { once: true },
    );
  });
}

export function openControlUiDatabase(): Promise<IDBDatabase> {
  if (databasePromise) {
    return databasePromise;
  }
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener(
      "upgradeneeded",
      () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("outboxPayloads")) {
          database.createObjectStore("outboxPayloads", { keyPath: "key" });
        }
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction?.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "key" });
        if (store && !store.indexNames.contains(OWNER_INDEX)) {
          store.createIndex(OWNER_INDEX, OWNER_INDEX, { unique: false });
        }
      },
      { once: true },
    );
    let blocked = false;
    request.addEventListener(
      "success",
      () => {
        const database = request.result;
        if (blocked) {
          database.close();
          databasePromise = null;
          return;
        }
        database.addEventListener("versionchange", () => {
          database.close();
          databasePromise = null;
        });
        resolve(database);
      },
      { once: true },
    );
    request.addEventListener(
      "error",
      () => {
        databasePromise = null;
        reject(indexedDbError(request.error, "IndexedDB open failed"));
      },
      { once: true },
    );
    request.addEventListener(
      "blocked",
      () => {
        // Keep the rejected promise until this open finishes. A second open
        // queues behind it and would otherwise wait forever without a blocked event.
        blocked = true;
        reject(new Error("IndexedDB upgrade was blocked"));
      },
      { once: true },
    );
  });
  return databasePromise;
}

// Matrix helper module supports idb persistence helpers behavior.
export async function clearAllIndexedDbState(params?: { databasePrefix?: string }): Promise<void> {
  const databases = await indexedDB.databases();
  const expectedPrefix = params?.databasePrefix ? `${params.databasePrefix}::` : null;
  await Promise.all(
    databases
      .map((entry) => entry.name)
      .filter((name): name is string => Boolean(name))
      .filter((name) => !expectedPrefix || name.startsWith(expectedPrefix))
      .map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase(name);
            req.addEventListener("success", () => resolve(), { once: true });
            req.addEventListener(
              "error",
              () => reject(toLintErrorObject(req.error, "Non-Error rejection")),
              { once: true },
            );
            req.addEventListener("blocked", () => resolve(), { once: true });
          }),
      ),
  );
}

export async function seedDatabase(params: {
  name: string;
  version?: number;
  storeName: string;
  records: Array<{ key: IDBValidKey; value: unknown }>;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(params.name, params.version ?? 1);
    req.addEventListener("upgradeneeded", () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(params.storeName)) {
        db.createObjectStore(params.storeName);
      }
    });
    req.addEventListener("success", () => {
      const db = req.result;
      const tx = db.transaction(params.storeName, "readwrite");
      const store = tx.objectStore(params.storeName);
      for (const record of params.records) {
        store.put(record.value, record.key);
      }
      tx.addEventListener("complete", () => {
        db.close();
        resolve();
      });
      tx.addEventListener(
        "error",
        () => reject(toLintErrorObject(tx.error, "Non-Error rejection")),
        { once: true },
      );
    });
    req.addEventListener(
      "error",
      () => reject(toLintErrorObject(req.error, "Non-Error rejection")),
      { once: true },
    );
  });
}

export async function readDatabaseRecords(params: {
  name: string;
  version?: number;
  storeName: string;
}): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open(params.name, params.version ?? 1);
    req.addEventListener("success", () => {
      const db = req.result;
      const tx = db.transaction(params.storeName, "readonly");
      const store = tx.objectStore(params.storeName);
      const keysReq = store.getAllKeys();
      const valuesReq = store.getAll();
      let keys: IDBValidKey[] | null = null;
      let values: unknown[] | null = null;

      const maybeResolve = () => {
        if (!keys || !values) {
          return;
        }
        db.close();
        const resolvedValues = values;
        resolve(keys.map((key, index) => ({ key, value: resolvedValues[index] })));
      };

      keysReq.addEventListener("success", () => {
        keys = keysReq.result;
        maybeResolve();
      });
      valuesReq.addEventListener("success", () => {
        values = valuesReq.result;
        maybeResolve();
      });
      keysReq.addEventListener(
        "error",
        () => reject(toLintErrorObject(keysReq.error, "Non-Error rejection")),
        { once: true },
      );
      valuesReq.addEventListener(
        "error",
        () => reject(toLintErrorObject(valuesReq.error, "Non-Error rejection")),
        { once: true },
      );
    });
    req.addEventListener(
      "error",
      () => reject(toLintErrorObject(req.error, "Non-Error rejection")),
      { once: true },
    );
  });
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

export async function clearAllIndexedDbState(): Promise<void> {
  const databases = await indexedDB.databases();
  await Promise.all(
    databases
      .map((entry) => entry.name)
      .filter((name): name is string => Boolean(name))
      .map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase(name);
            req.addEventListener("success", () => resolve(), { once: true });
            req.addEventListener("error", () => reject(req.error), { once: true });
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
      tx.addEventListener("error", () => reject(tx.error), { once: true });
    });
    req.addEventListener("error", () => reject(req.error), { once: true });
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
      keysReq.addEventListener("error", () => reject(keysReq.error), { once: true });
      valuesReq.addEventListener("error", () => reject(valuesReq.error), { once: true });
    });
    req.addEventListener("error", () => reject(req.error), { once: true });
  });
}

// Control UI test helper supports storage setup.
export function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

/** Replaces unsafe Node/jsdom storage accessors with an owned, working data property. */
export function installSafeLocalStorageForTesting(windowTarget?: Window): Storage {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  if (descriptor && !descriptor.get && descriptor.value) {
    const candidate = descriptor.value as Partial<Storage>;
    if (
      typeof candidate.getItem === "function" &&
      typeof candidate.setItem === "function" &&
      typeof candidate.removeItem === "function"
    ) {
      try {
        const probeKey = "__openclaw_local_storage_probe__";
        const previousValue = candidate.getItem(probeKey);
        candidate.setItem(probeKey, "1");
        const works = candidate.getItem(probeKey) === "1";
        if (previousValue === null) {
          candidate.removeItem(probeKey);
        } else {
          candidate.setItem(probeKey, previousValue ?? "");
        }
        if (works) {
          return candidate as Storage;
        }
      } catch {
        // Disabled Node WebStorage values and inert proxies need owned memory instead.
      }
    }
  }

  const storage = createStorageMock();
  const install = (target: object) =>
    Object.defineProperty(target, "localStorage", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: storage,
    });
  install(globalThis);
  if (windowTarget && (windowTarget as unknown) !== globalThis) {
    install(windowTarget);
  }
  return storage;
}

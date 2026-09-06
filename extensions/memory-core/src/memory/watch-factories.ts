import fsSync from "node:fs";
import chokidar, { type FSWatcher } from "chokidar";

const TEST_MEMORY_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
const TEST_MEMORY_NATIVE_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryNativeWatchFactory");

export function isWatchCapacityError(err: unknown): boolean {
  if (err === null || typeof err !== "object" || !("code" in err)) {
    return false;
  }
  return err.code === "EMFILE" || err.code === "ENFILE" || err.code === "ENOSPC";
}

export function resolveMemoryWatchFactory(forcePolling = false): typeof chokidar.watch {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    // SAFETY: test overrides are stored under this process-global symbol by the memory test harness.
    const override = (globalThis as Record<PropertyKey, unknown>)[TEST_MEMORY_WATCH_FACTORY_KEY];
    if (typeof override === "function") {
      // SAFETY: the runtime function check narrows the test override to the watcher factory contract.
      return override as typeof chokidar.watch;
    }
  }
  if (!forcePolling) {
    return chokidar.watch.bind(chokidar);
  }
  return (paths, options = {}) => {
    // Chokidar applies CHOKIDAR_USEPOLLING after constructor options. Capacity
    // recovery must win even when the environment globally disables polling.
    const pollingEnv = process.env.CHOKIDAR_USEPOLLING;
    let watcher: FSWatcher;
    try {
      delete process.env.CHOKIDAR_USEPOLLING;
      watcher = new chokidar.FSWatcher({ ...options, usePolling: true });
    } finally {
      if (pollingEnv === undefined) {
        delete process.env.CHOKIDAR_USEPOLLING;
      } else {
        process.env.CHOKIDAR_USEPOLLING = pollingEnv;
      }
    }
    watcher.add(paths);
    return watcher;
  };
}

export function resolveMemoryNativeWatchFactory(): typeof fsSync.watch {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    // SAFETY: test overrides are stored under this process-global symbol by the memory test harness.
    const override = (globalThis as Record<PropertyKey, unknown>)[
      TEST_MEMORY_NATIVE_WATCH_FACTORY_KEY
    ];
    if (typeof override === "function") {
      // SAFETY: the runtime function check narrows the test override to the native watcher contract.
      return override as typeof fsSync.watch;
    }
  }
  return fsSync.watch.bind(fsSync);
}

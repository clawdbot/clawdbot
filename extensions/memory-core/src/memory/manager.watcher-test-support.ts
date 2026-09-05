import { vi } from "vitest";

type ChokidarEvent = "add" | "change" | "unlink" | "unlinkDir" | "error" | "ready";
type ChokidarCallback = (...args: unknown[]) => void;
type NativeEvent = "error";
type NativeCallback = (eventType: string, filename: string | null) => void;
type NativeErrorCallback = (err: Error) => void;

const CHOKIDAR_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
const NATIVE_FACTORY_KEY = Symbol.for("openclaw.test.memoryNativeWatchFactory");

function createMockChokidarWatcher() {
  const handlers = new Map<ChokidarEvent, ChokidarCallback[]>();
  const onceHandlers = new Map<ChokidarEvent, ChokidarCallback[]>();
  const watcher = {
    watchedEntries: {} as Record<string, string[]>,
    on: vi.fn((event: ChokidarEvent, callback: ChokidarCallback) => {
      handlers.set(event, [...(handlers.get(event) ?? []), callback]);
      return watcher;
    }),
    once: vi.fn((event: ChokidarEvent, callback: ChokidarCallback) => {
      onceHandlers.set(event, [...(onceHandlers.get(event) ?? []), callback]);
      return watcher;
    }),
    add: vi.fn((_path: string | string[]) => watcher),
    close: vi.fn(async () => undefined),
    getWatched: vi.fn(() => watcher.watchedEntries),
    emit: (event: ChokidarEvent, ...args: unknown[]) => {
      for (const callback of handlers.get(event) ?? []) {
        callback(...args);
      }
      const callbacks = onceHandlers.get(event) ?? [];
      onceHandlers.delete(event);
      for (const callback of callbacks) {
        callback(...args);
      }
    },
  };
  return watcher;
}

function createMockNativeWatcher(
  dir: string,
  options: { recursive?: boolean },
  listener: NativeCallback,
) {
  const errorHandlers: NativeErrorCallback[] = [];
  const watcher = {
    dir,
    options,
    recursive: options.recursive === true,
    listener,
    on: vi.fn((event: NativeEvent, callback: NativeErrorCallback) => {
      if (event === "error") {
        errorHandlers.push(callback);
      }
      return watcher;
    }),
    close: vi.fn(() => undefined),
    emit: (eventType: string, filename: string | null) => {
      listener(eventType, filename);
    },
    emitError: (err: Error) => {
      for (const handler of errorHandlers) {
        handler(err);
      }
    },
  };
  return watcher;
}

export function createMemoryWatchTestHarness() {
  const createdChokidarWatchers: Array<ReturnType<typeof createMockChokidarWatcher>> = [];
  const createdNativeWatchers: Array<ReturnType<typeof createMockNativeWatcher>> = [];
  const nativeWatchMockFailingDir = { current: null as string | null };
  const watchMock = vi.fn(() => {
    const watcher = createMockChokidarWatcher();
    createdChokidarWatchers.push(watcher);
    return watcher;
  });
  const nativeWatchMock = vi.fn(
    (dir: string, options: { recursive?: boolean }, listener: NativeCallback) => {
      if (nativeWatchMockFailingDir.current && dir === nativeWatchMockFailingDir.current) {
        throw new Error("simulated native fs.watch creation failure");
      }
      const watcher = createMockNativeWatcher(dir, options, listener);
      createdNativeWatchers.push(watcher);
      return watcher;
    },
  );

  return {
    createdChokidarWatchers,
    createdNativeWatchers,
    nativeWatchMockFailingDir,
    watchMock,
    nativeWatchMock,
    install() {
      (globalThis as Record<PropertyKey, unknown>)[CHOKIDAR_FACTORY_KEY] = watchMock;
      (globalThis as Record<PropertyKey, unknown>)[NATIVE_FACTORY_KEY] = nativeWatchMock;
    },
    reset() {
      watchMock.mockClear();
      nativeWatchMock.mockClear();
      createdChokidarWatchers.length = 0;
      createdNativeWatchers.length = 0;
      nativeWatchMockFailingDir.current = null;
    },
    uninstall() {
      Reflect.deleteProperty(globalThis, CHOKIDAR_FACTORY_KEY);
      Reflect.deleteProperty(globalThis, NATIVE_FACTORY_KEY);
    },
  };
}

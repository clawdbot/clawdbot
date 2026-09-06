import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import {
  createWatcherConfigFixture,
  restoreWatcherStateDir,
  setWatcherStateDir,
} from "./manager-watcher-config.test-support.js";

const BUILT_IN_WATCH_DEBOUNCE_MS = 1_500;

type WatchCall = [string[], Record<string, unknown>];
type SyncMemoryFilesParams = {
  needsFullReindex: boolean;
  progress?: unknown;
};
type SyncInternals = {
  dirty: boolean;
  syncing: Promise<void> | null;
  syncMemoryFiles: (params: SyncMemoryFilesParams) => Promise<unknown>;
};

const {
  createdChokidarWatchers,
  createdNativeWatchers,
  memoryLoggerWarn,
  watchMock,
  nativeWatchMock,
  nativeWatchMockFailingDir,
  nativeWatchMockFailureCode,
} = vi.hoisted(() => {
  const chokidarKey = Symbol.for("openclaw.test.memoryWatchFactory");
  const nativeKey = Symbol.for("openclaw.test.memoryNativeWatchFactory");
  type ChokidarEvent = "add" | "change" | "unlink" | "unlinkDir" | "error" | "ready";
  type ChokidarCallback = (...args: unknown[]) => void;
  type NativeCallback = (eventType: string, filename: string | null) => void;
  type NativeErrorCallback = (err: Error) => void;

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
      close: vi.fn(async (): Promise<void> => undefined),
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
      on: vi.fn((event: "error", callback: NativeErrorCallback) => {
        if (event === "error") {
          errorHandlers.push(callback);
        }
        return watcher;
      }),
      close: vi.fn(() => undefined),
      emitError: (err: Error) => {
        for (const handler of errorHandlers) {
          handler(err);
        }
      },
    };
    return watcher;
  }

  const chokidarWatchers: Array<ReturnType<typeof createMockChokidarWatcher>> = [];
  const nativeWatchers: Array<ReturnType<typeof createMockNativeWatcher>> = [];
  const failingDir = { current: null as string | null };
  const failureCode = { current: null as string | null };
  const result = {
    createdChokidarWatchers: chokidarWatchers,
    createdNativeWatchers: nativeWatchers,
    memoryLoggerWarn: vi.fn(),
    watchMock: vi.fn(() => {
      const watcher = createMockChokidarWatcher();
      chokidarWatchers.push(watcher);
      return watcher;
    }),
    nativeWatchMock: vi.fn(
      (dir: string, options: { recursive?: boolean }, listener: NativeCallback) => {
        if (failingDir.current && dir === failingDir.current) {
          throw Object.assign(new Error("simulated native fs.watch creation failure"), {
            code: failureCode.current,
          });
        }
        const watcher = createMockNativeWatcher(dir, options, listener);
        nativeWatchers.push(watcher);
        return watcher;
      },
    ),
    nativeWatchMockFailingDir: failingDir,
    nativeWatchMockFailureCode: failureCode,
  };
  (globalThis as Record<PropertyKey, unknown>)[chokidarKey] = result.watchMock;
  (globalThis as Record<PropertyKey, unknown>)[nativeKey] = result.nativeWatchMock;
  return result;
});

const CHOKIDAR_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
const NATIVE_FACTORY_KEY = Symbol.for("openclaw.test.memoryNativeWatchFactory");

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: memoryLoggerWarn,
    }),
  };
});

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => ({
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    },
  }),
}));

import { clearEmbeddingProviders as clearRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexManager } from "./manager.js";

describe("memory watcher polling regressions", () => {
  let manager: MemoryIndexManager | null = null;
  let workspaceDir = "";
  let extraDir = "";
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.clearAllMocks();
    clearRegistry();
    nativeWatchMockFailingDir.current = null;
    nativeWatchMockFailureCode.current = null;
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, CHOKIDAR_FACTORY_KEY);
    Reflect.deleteProperty(globalThis, NATIVE_FACTORY_KEY);
  });

  afterEach(async () => {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    watchMock.mockClear();
    nativeWatchMock.mockClear();
    createdChokidarWatchers.length = 0;
    createdNativeWatchers.length = 0;
    nativeWatchMockFailingDir.current = null;
    nativeWatchMockFailureCode.current = null;
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    clearRegistry();
    restoreWatcherStateDir();
    closeOpenClawAgentDatabasesForTest();
    resetPluginStateStoreForTests();
    resetMemoryCoreDreamingStateForTests();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
      extraDir = "";
    }
  });

  async function setupWatcherWorkspace(): Promise<void> {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-polling-"));
    setWatcherStateDir(path.join(workspaceDir, "state"));
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "notes.md"), "hello");
  }

  function createWatcherConfig(): OpenClawConfig {
    return createWatcherConfigFixture(workspaceDir, extraDir, { extraPaths: [] });
  }

  function watchCall(index: number): WatchCall | undefined {
    return (watchMock.mock.calls as unknown as WatchCall[])[index];
  }

  async function expectWatcherManager(): Promise<MemoryIndexManager> {
    const result = await getMemorySearchManager({ cfg: createWatcherConfig(), agentId: "main" });
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  it("uses polling when Linux nested watcher setup exhausts capacity", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupWatcherWorkspace();
    const nestedDir = path.join(workspaceDir, "memory", "topic");
    await fs.mkdir(nestedDir);
    nativeWatchMockFailingDir.current = nestedDir;
    nativeWatchMockFailureCode.current = "ENOSPC";

    await expectWatcherManager();

    expect(watchMock).toHaveBeenCalledTimes(2);
    expect(watchCall(0)?.[0]).toStrictEqual([path.join(workspaceDir, "memory")]);
    expect(watchCall(1)?.[0]).toStrictEqual([
      path.join(workspaceDir, "MEMORY.md"),
      path.join(workspaceDir, "USER.md"),
    ]);
    const calls: Array<WatchCall | undefined> = [watchCall(0), watchCall(1)];
    expect(calls).toSatisfy((entries: Array<WatchCall | undefined>) =>
      entries.every((call: WatchCall | undefined) => call?.[1].usePolling === true),
    );
  });

  it("keeps polling catch-up dirty when a recovery sync is already in flight", async () => {
    await setupWatcherWorkspace();
    await configureMemoryCoreDreamingStateForTests();
    const activeManager = await expectWatcherManager();
    await activeManager.sync({ reason: "test-initial-index" });
    const internals = activeManager as unknown as SyncInternals;
    internals.dirty = false;
    const originalSyncMemoryFiles = internals.syncMemoryFiles.bind(activeManager);
    let signalSyncStarted: () => void = () => {};
    const syncStarted = new Promise<void>((resolve: () => void) => {
      signalSyncStarted = resolve;
    });
    let releaseSync: () => void = () => {};
    const syncRelease = new Promise<void>((resolve: () => void) => {
      releaseSync = resolve;
    });
    vi.spyOn(internals, "syncMemoryFiles").mockImplementation(
      async (params: SyncMemoryFilesParams) => {
        signalSyncStarted();
        await syncRelease;
        return await originalSyncMemoryFiles(params);
      },
    );
    vi.useFakeTimers();
    const memoryDir = path.join(workspaceDir, "memory");
    const memoryWatcher = createdNativeWatchers.find((watcher) => watcher.dir === memoryDir);

    memoryWatcher?.emitError(
      Object.assign(new Error("watcher capacity exhausted"), { code: "ENOSPC" }),
    );
    const firstRefresh = vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
    await syncStarted;
    createdChokidarWatchers.at(-1)?.emit("ready");
    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
    releaseSync();
    await firstRefresh;
    await internals.syncing;

    expect(internals.dirty).toBe(true);
  });
});

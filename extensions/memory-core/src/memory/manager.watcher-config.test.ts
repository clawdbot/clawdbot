// Memory Core tests cover manager.watcher config plugin behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  MemorySearchConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WatchIgnoredFn = (watchPath: string, stats?: { isDirectory?: () => boolean }) => boolean;

const BUILT_IN_WATCH_DEBOUNCE_MS = 1_500;

const {
  createdChokidarWatchers,
  createdNativeWatchers,
  memoryLoggerWarn,
  watchMock,
  nativeWatchMock,
  nativeWatchMockFailingDir,
} = vi.hoisted(() => {
  // Symbols are also declared at module top-level (CHOKIDAR_FACTORY_KEY,
  // NATIVE_FACTORY_KEY) but vi.hoisted runs before those declarations
  // execute, so we resolve the same Symbol.for keys inline here.
  const chokidarKey = Symbol.for("openclaw.test.memoryWatchFactory");
  const nativeKey = Symbol.for("openclaw.test.memoryNativeWatchFactory");
  type ChokidarEvent = "add" | "change" | "unlink" | "unlinkDir" | "error" | "ready";
  type ChokidarCallback = (...args: unknown[]) => void;
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

  type NativeEvent = "error";
  type NativeCallback = (eventType: string, filename: string | null) => void;
  type NativeErrorCallback = (err: Error) => void;
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

  const chokidarWatchers: Array<ReturnType<typeof createMockChokidarWatcher>> = [];
  const nativeWatchers: Array<ReturnType<typeof createMockNativeWatcher>> = [];
  const failingDir = { current: null as string | null };

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
          throw new Error("simulated native fs.watch creation failure");
        }
        const watcher = createMockNativeWatcher(dir, options, listener);
        nativeWatchers.push(watcher);
        return watcher;
      },
    ),
    nativeWatchMockFailingDir: failingDir,
  };
  (globalThis as Record<PropertyKey, unknown>)[chokidarKey] = result.watchMock;
  (globalThis as Record<PropertyKey, unknown>)[nativeKey] = result.nativeWatchMock;
  return result;
});

const CHOKIDAR_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
const NATIVE_FACTORY_KEY = Symbol.for("openclaw.test.memoryNativeWatchFactory");
const originalWatcherStateDir = process.env.OPENCLAW_STATE_DIR;

function setWatcherStateDir(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

function restoreWatcherStateDir(): void {
  if (originalWatcherStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalWatcherStateDir);
  }
}

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
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

describe("memory watcher config", () => {
  let manager: MemoryIndexManager | null = null;
  let workspaceDir = "";
  let extraDir = "";
  let originalPlatform: NodeJS.Platform;

  beforeEach(async () => {
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    vi.clearAllMocks();
    clearRegistry();
    nativeWatchMockFailingDir.current = null;
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
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    clearRegistry();
    restoreWatcherStateDir();
    // The agent close releases its leases through shared state and reopens it, so the
    // shared handle is released second; otherwise Windows fails the removal with EBUSY.
    closeOpenClawAgentDatabasesForTest();
    resetPluginStateStoreForTests();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
      extraDir = "";
    }
  });

  async function setupWatcherWorkspace(seedFile: { name: string; contents: string }) {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-"));
    setWatcherStateDir(path.join(workspaceDir, "state"));
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, seedFile.name), seedFile.contents);
  }

  function createWatcherConfig(overrides?: Partial<MemorySearchConfig>): OpenClawConfig {
    return isolateMemoryManagerTestConfig({
      memory: {
        search: {
          provider: "openai",
          model: "mock-embed",
          store: { vector: { enabled: false } },
          query: { minScore: 0 },
          extraPaths: [extraDir],
          ...overrides,
        },
      },
      agents: { entries: { main: { workspace: workspaceDir } } },
    });
  }

  async function expectWatcherManager(cfg: OpenClawConfig, agentId = "main") {
    const result = await getMemorySearchManager({ cfg, agentId });
    if (!result.manager) {
      throw new Error("manager missing");
    }
    expect(result.manager.status().backend).toBe("builtin");
    expect(result.manager.status().sources).toContain("memory");
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  async function setupParentWatchLifecycle(platform: NodeJS.Platform, extraRoot = false) {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const parentDir = extraRoot ? path.join(extraDir, "parent") : workspaceDir;
    const dir = path.join(parentDir, "memory");
    await fs.mkdir(dir, { recursive: true });
    const activeManager = await expectWatcherManager(
      createWatcherConfig({ extraPaths: extraRoot ? [dir] : [] }),
    );
    const main = createdNativeWatchers.find((watcher) => watcher.dir === dir);
    const parent = createdNativeWatchers.find((watcher) => watcher.dir === parentDir);
    if (!main || !parent) {
      throw new Error("expected a main and parent memory watcher");
    }
    vi.useFakeTimers();
    const sync = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);
    return { activeManager, dir, parentDir, main, parent, sync };
  }

  it.each(["darwin", "win32"])(
    "routes directories to native recursive watch on %s",
    async (platform) => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const cfg = createWatcherConfig();

      await expectWatcherManager(cfg);

      // Chokidar should only see file paths (MEMORY.md); directories use native watch.
      expect(watchMock).toHaveBeenCalledTimes(1);
      const [chokidarPaths, chokidarOptions] = watchMock.mock.calls[0] as unknown as [
        string[],
        Record<string, unknown>,
      ];
      expect(chokidarPaths).toStrictEqual([
        path.join(workspaceDir, "MEMORY.md"),
        path.join(workspaceDir, "USER.md"),
      ]);
      expect(chokidarPaths.filter((watchedPath) => watchedPath.includes("*"))).toEqual([]);
      expect(chokidarOptions.ignoreInitial).toBe(true);
      expect(chokidarOptions).not.toHaveProperty("awaitWriteFinish");

      // Native fs.watch should receive memory/ and extraDir as recursive watches.
      // Each watched directory installs a main recursive watcher PLUS a
      // non-recursive parent-directory watcher used to detect root
      // replacement (see attachNativeMemoryWatchForDir). 2 dirs × 2 watchers
      // each = 4 native fs.watch calls.
      expect(nativeWatchMock).toHaveBeenCalledTimes(4);
      const mainNativeCalls = (
        nativeWatchMock.mock.calls as unknown as [string, { recursive?: boolean }, unknown][]
      ).filter((call) => call[1].recursive === true);
      const parentNativeCalls = (
        nativeWatchMock.mock.calls as unknown as [string, { recursive?: boolean }, unknown][]
      ).filter((call) => call[1].recursive !== true);
      expect(mainNativeCalls.map((call) => call[0])).toStrictEqual(
        expect.arrayContaining([path.join(workspaceDir, "memory"), extraDir]),
      );
      expect(parentNativeCalls.map((call) => call[0])).toStrictEqual([workspaceDir, workspaceDir]);
      expect(parentNativeCalls.every((call) => call[1].recursive === false)).toBe(true);

      // Shared ignore predicate still controls non-md/non-multimodal churn.
      const ignored = chokidarOptions.ignored as WatchIgnoredFn | undefined;
      expect(ignored).toBeTypeOf("function");
      expect(ignored?.(path.join(workspaceDir, "memory", "node_modules", "pkg", "index.md"))).toBe(
        true,
      );
      expect(ignored?.(path.join(workspaceDir, "memory", ".venv", "lib", "python.md"))).toBe(true);
      expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.tmp"), {})).toBe(true);
      expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.json"), {})).toBe(true);
      expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.json"), undefined)).toBe(
        false,
      );
      expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.md"))).toBe(false);
      expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.md"), {})).toBe(false);
      expect(
        ignored?.(path.join(workspaceDir, "memory", "project"), { isDirectory: () => true }),
      ).toBe(false);
    },
  );

  it.each(["notes", "..notes"])(
    "filters %s file events while watching the directory root",
    async (directory) => {
      await setupWatcherWorkspace({ name: "seed.md", contents: "seed" });
      await fs.mkdir(path.join(extraDir, directory), { recursive: true });
      await fs.mkdir(path.join(extraDir, "drafts"), { recursive: true });
      await fs.writeFile(path.join(extraDir, directory, "keep.md"), "keep");
      await fs.writeFile(path.join(extraDir, "drafts", "skip.md"), "skip");
      const cfg = createWatcherConfig({
        extraPaths: [{ path: extraDir, pattern: `${directory}/**/*.md` }],
      });

      const activeManager = await expectWatcherManager(cfg);
      const extraWatcher = createdNativeWatchers.find(
        (watcher) => watcher.dir === extraDir && watcher.recursive,
      );
      expect(extraWatcher).toBeDefined();
      vi.useFakeTimers();
      const syncSpy = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);

      extraWatcher?.emit("change", path.join("drafts", "skip.md"));
      await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
      expect(syncSpy).not.toHaveBeenCalled();

      extraWatcher?.emit("change", path.join(directory, "keep.md"));
      await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
      expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
    },
  );

  it("does not start watchers for one-shot CLI managers", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    const result = await getMemorySearchManager({ cfg, agentId: "main", purpose: "cli" });
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;

    expect(watchMock).not.toHaveBeenCalled();
    expect(nativeWatchMock).not.toHaveBeenCalled();
  });

  it("watches multimodal extra directories via native watch", async () => {
    await setupWatcherWorkspace({ name: "PHOTO.PNG", contents: "png" });
    const cfg = createWatcherConfig({
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
      multimodal: { enabled: true, modalities: ["image", "audio"] },
    });

    await expectWatcherManager(cfg);

    expect(watchMock).toHaveBeenCalledTimes(1);
    const [chokidarPaths, chokidarOptions] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(chokidarPaths).toStrictEqual([
      path.join(workspaceDir, "MEMORY.md"),
      path.join(workspaceDir, "USER.md"),
    ]);

    // 2 directories × (main + parent) = 4 native watch calls.
    expect(nativeWatchMock).toHaveBeenCalledTimes(4);
    const nativeDirs = (
      nativeWatchMock.mock.calls as unknown as [string, { recursive?: boolean }, unknown][]
    )
      .filter((call) => call[1].recursive === true)
      .map((call) => call[0]);
    expect(nativeDirs).toStrictEqual(
      expect.arrayContaining([path.join(workspaceDir, "memory"), extraDir]),
    );
    const ignored = chokidarOptions.ignored as WatchIgnoredFn | undefined;
    expect(ignored).toBeTypeOf("function");
    expect(ignored?.(path.join(extraDir, "nested", "PHOTO.PNG"))).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "PHOTO.PNG"), {})).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "voice.WAV"))).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "voice.WAV"), {})).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "metadata.json"), {})).toBe(true);
  });

  it.each(["add", "change", "unlink", "unlinkDir"] as const)(
    "schedules watch sync on chokidar %s events",
    async (event) => {
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const cfg = createWatcherConfig();

      const activeManager = await expectWatcherManager(cfg);
      vi.useFakeTimers();
      const syncSpy = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);

      createdChokidarWatchers[0]?.emit(event);
      await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);

      expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
    },
  );

  it.each(["rename", "change"] as const)(
    "schedules watch sync on native %s events",
    async (eventType) => {
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const cfg = createWatcherConfig();

      const activeManager = await expectWatcherManager(cfg);
      vi.useFakeTimers();
      const syncSpy = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);

      const memoryWatcher = createdNativeWatchers.find(
        (w) => w.dir === path.join(workspaceDir, "memory"),
      );
      memoryWatcher?.emit(eventType, "notes.md");
      await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);

      expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
    },
  );

  it("forces broad re-sync when native watch emits null filename", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    const activeManager = await expectWatcherManager(cfg);
    vi.useFakeTimers();
    const syncSpy = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);

    const memoryWatcher = createdNativeWatchers.find(
      (w) => w.dir === path.join(workspaceDir, "memory"),
    );
    // Node docs warn that filename may be null on some platforms; conservative
    // dirty must still be scheduled.
    memoryWatcher?.emit("rename", null as unknown as string);
    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);

    expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
  });

  it("falls back to chokidar when native fs.watch creation fails", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    nativeWatchMockFailingDir.current = path.join(workspaceDir, "memory");
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);

    // Native watch for memory/ threw — that dir should fall back into chokidar's set.
    expect(nativeWatchMock).toHaveBeenCalled();
    expect(watchMock).toHaveBeenCalledTimes(1);
    const [chokidarPathsFallback] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(chokidarPathsFallback).toStrictEqual(
      expect.arrayContaining([
        path.join(workspaceDir, "MEMORY.md"),
        path.join(workspaceDir, "USER.md"),
        path.join(workspaceDir, "memory"),
      ]),
    );
    expect(memoryLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining(
        `failed to start native recursive watcher on ${path.join(workspaceDir, "memory")}`,
      ),
    );
  });

  it("logs and removes native watcher on runtime error, marks dirty, and restores coverage via chokidar", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    const activeManager = await expectWatcherManager(cfg);
    vi.useFakeTimers();
    const syncSpy = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);

    const memoryDir = path.join(workspaceDir, "memory");
    const memoryWatcher = createdNativeWatchers.find((w) => w.dir === memoryDir);
    expect(memoryWatcher).toBeDefined();
    const closeSpy = memoryWatcher!.close;

    // Pre-error: chokidar has root memory files only; memoryDir is not in its set.
    const existingChokidar = createdChokidarWatchers[0];
    expect(existingChokidar).toBeDefined();
    const addSpy = vi.spyOn(
      existingChokidar as unknown as { add: (path: string) => unknown },
      "add",
    );

    memoryWatcher?.emitError(new Error("watcher error: ENOSPC"));
    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);

    expect(memoryLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("memory native watcher error"),
    );
    expect(closeSpy).toHaveBeenCalled();
    // Broad re-sync should be scheduled to cover the gap.
    expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
    // Coverage must be restored: the affected directory should now be
    // attached to the existing chokidar watcher.
    expect(addSpy).toHaveBeenCalledWith(memoryDir);

    // Sanity: a subsequent chokidar-style event on the now-fallback path
    // continues to schedule sync.
    syncSpy.mockClear();
    existingChokidar?.emit("change");
    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
    expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
  });

  it("routes Linux directories through directory-only native watchers", async () => {
    // Node's Linux `fs.watch({ recursive: true })` watches every file via
    // internal/fs/recursive_watch. OpenClaw watches directories only so
    // large file-heavy memory trees do not allocate per-file watchers.
    const originalPlatformValue = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      await fs.mkdir(path.join(workspaceDir, "memory", "nested"), { recursive: true });
      const cfg = createWatcherConfig();

      await expectWatcherManager(cfg);

      // Chokidar should only receive file paths. Linux directories use
      // non-recursive native directory watches.
      expect(watchMock).toHaveBeenCalledTimes(1);
      const [chokidarPathsLinux] = watchMock.mock.calls[0] as unknown as [
        string[],
        Record<string, unknown>,
      ];
      expect(chokidarPathsLinux).toStrictEqual([
        path.join(workspaceDir, "MEMORY.md"),
        path.join(workspaceDir, "USER.md"),
      ]);

      const nativeCalls = nativeWatchMock.mock.calls as unknown as [
        string,
        { recursive?: boolean },
        unknown,
      ][];
      expect(nativeCalls.every((call) => call[1].recursive !== true)).toBe(true);
      expect(nativeCalls.map((call) => call[0])).toStrictEqual(
        expect.arrayContaining([
          path.join(workspaceDir, "memory"),
          path.join(workspaceDir, "memory", "nested"),
          extraDir,
          workspaceDir,
        ]),
      );
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatformValue,
        configurable: true,
      });
    }
  });

  it("warns when Linux memory watching tracks many directories", async () => {
    const originalPlatformValue = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const root = path.join(workspaceDir, "memory");
      for (let i = 0; i < 2_001; i += 1) {
        await fs.mkdir(path.join(root, `topic-${i}`));
      }
      const cfg = createWatcherConfig({ extraPaths: [] });
      cfg.agents = {
        ownership: "explicit",
        entries: { main: {}, "watch-linux": { workspace: workspaceDir } },
      };
      vi.useFakeTimers();

      await expectWatcherManager(cfg, "watch-linux");
      expect(memoryLoggerWarn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(memoryLoggerWarn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(memoryLoggerWarn).toHaveBeenCalledExactlyOnceWith(
        "Memory file watching is tracking 2002 directories. Large memory folders or extraPaths can make OpenClaw run out of file watchers or open files. Remove unnecessary memory.search.extraPaths entries or narrow their directory roots, including per-agent entries; otherwise review the host's file-watch/open-file limits. After changes, restart the Gateway. To refresh the affected index, run in the Gateway's environment: openclaw memory index --force --agent watch-linux.",
      );
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatformValue,
        configurable: true,
      });
    }
  });

  it("attaches Linux native watchers for new subdirectories", async () => {
    const { dir, main, sync } = await setupParentWatchLifecycle("linux");
    const newDir = path.join(dir, "new-topic");
    await fs.mkdir(newDir);
    main.emit("rename", "new-topic");
    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);

    expect(sync).toHaveBeenCalledWith({ reason: "watch" });
    expect(
      createdNativeWatchers.some((watcher) => watcher.dir === newDir && !watcher.recursive),
    ).toBe(true);
  });

  it.each([false, true])(
    "releases Linux subtrees and reattaches recreated=%s",
    async (recreated) => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const memoryDir = path.join(workspaceDir, "memory");
      const nestedDir = path.join(memoryDir, "topic");
      const childDir = path.join(nestedDir, "child");
      await fs.mkdir(childDir, { recursive: true });
      const cfg = createWatcherConfig();

      await expectWatcherManager(cfg);

      const nestedWatcher = createdNativeWatchers.find((w) => w.dir === nestedDir);
      const childWatcher = createdNativeWatchers.find((w) => w.dir === childDir);
      expect(nestedWatcher).toBeDefined();
      expect(childWatcher).toBeDefined();
      await fs.rm(nestedDir, { recursive: true, force: true });
      if (recreated) {
        await fs.mkdir(nestedDir);
      }

      const memoryWatcher = createdNativeWatchers.find((w) => w.dir === memoryDir);
      memoryWatcher?.emit("rename", "topic");

      expect(nestedWatcher!.close).toHaveBeenCalled();
      expect(childWatcher!.close).toHaveBeenCalled();
      expect(createdNativeWatchers.filter((w) => w.dir === nestedDir)).toHaveLength(
        recreated ? 2 : 1,
      );
    },
  );

  it("keeps startup chokidar fallback when Linux nested watcher setup fails", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const nestedDir = path.join(workspaceDir, "memory", "topic");
    await fs.mkdir(nestedDir);
    nativeWatchMockFailingDir.current = nestedDir;
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);

    expect(watchMock).toHaveBeenCalledTimes(1);
    const [fallbackPaths] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(fallbackPaths).toStrictEqual([path.join(workspaceDir, "memory")]);
    expect(createdChokidarWatchers[0]?.add).toHaveBeenCalledWith([
      path.join(workspaceDir, "MEMORY.md"),
      path.join(workspaceDir, "USER.md"),
    ]);
  });

  it("schedules startup sync when the Linux root disappears during its initial scan", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const dir = path.join(workspaceDir, "memory");
    const originalReaddir = fsSync.readdirSync.bind(fsSync);
    const readdirSpy = vi.spyOn(fsSync, "readdirSync");
    readdirSpy.mockImplementation((...args: Parameters<typeof fsSync.readdirSync>) => {
      if (String(args[0]) === dir) {
        fsSync.renameSync(dir, path.join(workspaceDir, "previous-memory"));
      }
      return originalReaddir(...args);
    });
    try {
      vi.useFakeTimers();
      const activeManager = await expectWatcherManager(createWatcherConfig({ extraPaths: [] }));
      const main = createdNativeWatchers.find((watcher) => watcher.dir === dir);
      expect(main).toBeDefined();
      expect(main!.close).toHaveBeenCalledTimes(1);
      expect(createdNativeWatchers.some((watcher) => watcher.dir === workspaceDir)).toBe(false);
      expect(watchMock).toHaveBeenCalledTimes(1);
      const sync = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);
      // ignoreInitial fallback cannot replace the broad sync lost with native coverage.
      await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
      expect(sync).toHaveBeenCalledExactlyOnceWith({ reason: "watch" });
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it.each(["ENOENT", "EACCES", "ROOT_REPLACED", "CHILD_STAT_MISSING"])(
    "handles Linux subtree scan %s",
    async (code) => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const dir = path.join(workspaceDir, "memory");
      const nestedDir = path.join(dir, "racy-topic");
      await fs.mkdir(path.join(nestedDir, "survivor"), { recursive: true });
      const originalLstat = fsSync.lstatSync.bind(fsSync);
      const lstatSpy = vi.spyOn(fsSync, "lstatSync");
      lstatSpy.mockImplementation((...args: Parameters<typeof fsSync.lstatSync>) => {
        if (String(args[0]) === nestedDir && (code === "ENOENT" || code === "EACCES")) {
          throw Object.assign(new Error(`subtree lstat ${code}`), { code });
        }
        return originalLstat(...args);
      });
      const originalReaddir = fsSync.readdirSync.bind(fsSync);
      const readdirSpy = vi.spyOn(fsSync, "readdirSync");
      readdirSpy.mockImplementation((...args: Parameters<typeof fsSync.readdirSync>) => {
        if (String(args[0]) === nestedDir && code === "CHILD_STAT_MISSING") {
          throw Object.assign(new Error("DT_UNKNOWN child disappeared"), { code: "ENOENT" });
        }
        if (String(args[0]) === nestedDir && code === "ROOT_REPLACED") {
          fsSync.renameSync(dir, path.join(workspaceDir, "previous-memory"));
          fsSync.mkdirSync(dir);
        }
        return originalReaddir(...args);
      });
      try {
        const activeManager = await expectWatcherManager(createWatcherConfig({ extraPaths: [] }));
        const main = createdNativeWatchers.find((watcher) => watcher.dir === dir);
        expect(main).toBeDefined();
        expect(watchMock).toHaveBeenCalledTimes(1);
        expect(main!.close).toHaveBeenCalledTimes(1);
        expect(watchMock).toHaveBeenCalledWith(
          [dir],
          expect.objectContaining({ ignoreInitial: true }),
        );
        expect(createdChokidarWatchers[0]?.add).toHaveBeenCalledWith([
          path.join(workspaceDir, "MEMORY.md"),
          path.join(workspaceDir, "USER.md"),
        ]);
        expect(memoryLoggerWarn).toHaveBeenCalledWith(
          expect.stringContaining("failed to attach Linux memory directory watcher subtree"),
        );
        vi.useFakeTimers();
        const sync = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);
        createdChokidarWatchers[0]?.emit("change");
        await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
        expect(sync).toHaveBeenCalledWith({ reason: "watch" });
      } finally {
        lstatSpy.mockRestore();
        readdirSpy.mockRestore();
      }
    },
  );

  it("creates a chokidar watcher on the fly when no file-path chokidar exists yet", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig({ extraPaths: [] });

    // Root memory files stay watch paths even when missing, and chokidar handles
    // missing paths fine. To truly test the "no chokidar
    // yet" branch we instead simulate by clearing the watchMock buffer and
    // exercising attachMemoryChokidarFallback directly.
    await expectWatcherManager(cfg);
    vi.useFakeTimers();

    const memoryDir = path.join(workspaceDir, "memory");
    const memoryWatcher = createdNativeWatchers.find((w) => w.dir === memoryDir);
    expect(memoryWatcher).toBeDefined();

    // Pretend chokidar was never set up by clearing the manager.watcher slot,
    // then trigger the native error; the fallback must spin up a new chokidar.
    (manager as unknown as { watcher: unknown }).watcher = null;
    const chokidarCallsBefore = watchMock.mock.calls.length;

    memoryWatcher?.emitError(new Error("watcher error: ENOSPC"));
    await vi.advanceTimersByTimeAsync(50);

    expect(watchMock.mock.calls.length).toBe(chokidarCallsBefore + 1);
    const newChokidarCall = watchMock.mock.calls[chokidarCallsBefore] as unknown as
      | [string[], Record<string, unknown>]
      | undefined;
    expect(newChokidarCall?.[0]).toStrictEqual([memoryDir]);
  });

  it("treats null parent-watcher filename as an unknown event and re-checks the inode", async () => {
    const { main, parent, sync } = await setupParentWatchLifecycle("darwin");
    const nativeCallsBefore = nativeWatchMock.mock.calls.length;
    parent.emit("rename", null);
    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);

    // The unchanged inode must not trigger teardown or a broad sync.
    expect(main.close).not.toHaveBeenCalled();
    expect(parent.close).not.toHaveBeenCalled();
    expect(nativeWatchMock.mock.calls.length).toBe(nativeCallsBefore);
    expect(sync).not.toHaveBeenCalled();
  });

  it("closes the paired parent watcher when the native main watcher errors", async () => {
    // When the main native watcher dies and falls back to chokidar, the
    // paired parent watcher must also be closed — otherwise a later
    // root-replacement event would reattach native coverage on top of an
    // already-installed chokidar fallback, creating duplicate handles
    // and event paths.
    const { main, parent } = await setupParentWatchLifecycle("darwin");
    main.emitError(new Error("watcher error: ENOSPC"));

    // The error handler should have closed and removed the paired
    // parent watcher before installing the chokidar fallback.
    expect(parent.close).toHaveBeenCalled();
  });

  it("ignores parent-directory events for unrelated basenames", async () => {
    const { main, parent, sync } = await setupParentWatchLifecycle("darwin");
    const nativeCallsBefore = nativeWatchMock.mock.calls.length;
    parent.emit("rename", "unrelated-sibling-dir");
    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);

    expect(main.close).not.toHaveBeenCalled();
    expect(nativeWatchMock.mock.calls.length).toBe(nativeCallsBefore);
    expect(sync).not.toHaveBeenCalled();
  });

  it("ignores re-entrant ensureWatcher calls", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);
    const chokidarCallsAfterFirst = watchMock.mock.calls.length;
    const nativeCallsAfterFirst = nativeWatchMock.mock.calls.length;

    // Simulate a second ensureWatcher() call by reaching into the manager.
    const ensureWatcher = (manager as unknown as { ensureWatcher: () => void }).ensureWatcher;
    ensureWatcher?.call(manager);

    expect(watchMock.mock.calls.length).toBe(chokidarCallsAfterFirst);
    expect(nativeWatchMock.mock.calls.length).toBe(nativeCallsAfterFirst);
  });

  describe.each(["darwin", "win32", "linux"] as const)("%s parent watch lifecycle", (platform) => {
    it.each(["memory", null])("reattaches a replaced root for filename %s", async (filename) => {
      const { dir, main, parent, sync } = await setupParentWatchLifecycle(platform);
      await fs.rename(dir, path.join(workspaceDir, "previous-memory"));
      await fs.mkdir(dir);

      parent.emit("rename", filename);

      expect(main.close).toHaveBeenCalledTimes(1);
      expect(parent.close).toHaveBeenCalledTimes(1);
      const replacements = createdNativeWatchers.filter((watcher) => watcher.dir === dir);
      expect(replacements).toHaveLength(2);
      expect(replacements[1]?.recursive).toBe(platform !== "linux");
      expect(createdChokidarWatchers[0]?.add).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
      expect(sync).toHaveBeenCalledWith({ reason: "watch" });

      sync.mockClear();
      await fs.writeFile(path.join(dir, "fresh.md"), "fresh memory");
      replacements[1]?.emit("change", "fresh.md");
      await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
      expect(sync).toHaveBeenCalledWith({ reason: "watch" });
    });

    const failures = [
      "missing",
      "stat-race",
      "stat-failure",
      "creation-failure",
      "parent-replaced",
      "retained-parent-replaced",
    ];
    if (platform === "linux") {
      failures.push("subtree-race");
    }
    it.each(failures)(
      "preserves watch coverage when reattachment encounters %s",
      async (failure) => {
        const parentReplaced =
          failure === "parent-replaced" || failure === "retained-parent-replaced";
        const { dir, parentDir, main, parent, sync } = await setupParentWatchLifecycle(
          platform,
          parentReplaced,
        );
        await fs.rename(dir, path.join(workspaceDir, "previous-memory"));
        if (failure === "retained-parent-replaced") {
          parent.emit("rename", "memory");
          expect(parent.close).not.toHaveBeenCalled();
        }
        if (parentReplaced) {
          await fs.rename(parentDir, path.join(extraDir, "previous-parent"));
          await fs.mkdir(parentDir);
        } else if (failure !== "missing") {
          await fs.mkdir(dir);
        }
        const originalStat = fsSync.statSync.bind(fsSync);
        let rootStats = 0;
        const statSpy = vi.spyOn(fsSync, "statSync");
        statSpy.mockImplementation((...args: Parameters<typeof fsSync.statSync>) => {
          if (String(args[0]) === dir && failure === "stat-failure") {
            throw Object.assign(new Error("root stat failed"), { code: "EACCES" });
          }
          if (String(args[0]) === dir && failure === "stat-race" && ++rootStats > 1) {
            throw Object.assign(new Error("root disappeared before reattachment"), {
              code: "ENOENT",
            });
          }
          return originalStat(...args);
        });
        if (failure === "creation-failure") {
          nativeWatchMockFailingDir.current = dir;
        }
        const originalLstat = fsSync.lstatSync.bind(fsSync);
        const lstatSpy = vi.spyOn(fsSync, "lstatSync");
        lstatSpy.mockImplementation((...args: Parameters<typeof fsSync.lstatSync>) => {
          if (String(args[0]) === dir && failure === "subtree-race") {
            fsSync.renameSync(dir, path.join(workspaceDir, "raced-memory"));
          }
          return originalLstat(...args);
        });

        try {
          parent.emit(
            "rename",
            failure === "retained-parent-replaced" ? path.basename(parentDir) : "memory",
          );
        } finally {
          statSpy.mockRestore();
          lstatSpy.mockRestore();
        }

        expect(main.close).toHaveBeenCalledTimes(1);
        const roots = createdNativeWatchers.filter((watcher) => watcher.dir === dir);
        expect(roots).toHaveLength(failure === "subtree-race" ? 2 : 1);
        for (const root of roots) {
          expect(root.close).toHaveBeenCalledTimes(1);
        }
        await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
        expect(sync).toHaveBeenCalledWith({ reason: "watch" });
        sync.mockClear();
        if (failure === "creation-failure" || failure === "stat-failure" || parentReplaced) {
          expect(parent.close).toHaveBeenCalledTimes(1);
          expect(createdChokidarWatchers[0]?.add).toHaveBeenCalledExactlyOnceWith(dir);
          createdChokidarWatchers[0]?.emit("change");
        } else {
          expect(parent.close).not.toHaveBeenCalled();
          expect(createdChokidarWatchers[0]?.add).not.toHaveBeenCalled();
          main.emitError(new Error("stale closed main"));
          main.emit("rename", null);
          await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
          expect(sync).not.toHaveBeenCalled();
          if (failure === "missing" || failure === "subtree-race") {
            parent.emit("rename", null);
            expect(main.close).toHaveBeenCalledTimes(1);
            await fs.mkdir(dir);
          }
          parent.emit("rename", "memory");
          expect(parent.close).toHaveBeenCalledTimes(1);
          expect(main.close).toHaveBeenCalledTimes(1);
          expect(createdChokidarWatchers[0]?.add).not.toHaveBeenCalled();
          expect(createdNativeWatchers.filter((watcher) => watcher.dir === dir)).toHaveLength(
            roots.length + 1,
          );
        }
        await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
        expect(sync).toHaveBeenCalledExactlyOnceWith({ reason: "watch" });
      },
    );

    it.each([false, true])(
      "keeps coverage after a parent error with root missing=%s",
      async (missing) => {
        const { activeManager, dir, main, parent, sync } =
          await setupParentWatchLifecycle(platform);
        if (missing) {
          await fs.rename(dir, path.join(workspaceDir, "previous-memory"));
          parent.emit("rename", "memory");
        }
        parent.emitError(new Error("parent unavailable"));
        expect(parent.close).toHaveBeenCalledTimes(1);
        expect(main.close).toHaveBeenCalledTimes(missing ? 1 : 0);
        if (missing) {
          expect(createdChokidarWatchers[0]?.add).toHaveBeenCalledExactlyOnceWith(dir);
          createdChokidarWatchers[0]?.emit("change");
        } else {
          expect(createdChokidarWatchers[0]?.add).not.toHaveBeenCalled();
          main.emit("change", "notes.md");
        }
        expect(memoryLoggerWarn).toHaveBeenCalledWith(
          `memory ${platform === "linux" ? "Linux" : "native"} parent watcher error on ${workspaceDir}: parent unavailable`,
        );
        await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
        expect(sync).toHaveBeenCalledWith({ reason: "watch" });
        await activeManager.close();
        expect(main.close).toHaveBeenCalledTimes(1);
        expect(parent.close).toHaveBeenCalledTimes(1);
      },
    );

    it.each([false, true])(
      "retains main coverage without a parent with root symlink=%s",
      async (symlink) => {
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
        if (symlink) {
          const memoryDir = path.join(workspaceDir, "memory");
          const target = path.join(workspaceDir, "memory-target");
          await fs.rename(memoryDir, target);
          await fs.symlink(target, memoryDir, originalPlatform === "win32" ? "junction" : "dir");
        }
        nativeWatchMockFailingDir.current = workspaceDir;
        const activeManager = await expectWatcherManager(createWatcherConfig({ extraPaths: [] }));
        const main = createdNativeWatchers.find(
          (watcher) => watcher.dir === path.join(workspaceDir, "memory"),
        );
        vi.useFakeTimers();
        const sync = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);

        expect(main?.close).not.toHaveBeenCalled();
        main?.emit("change", "notes.md");
        await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);

        expect(sync).toHaveBeenCalledWith({ reason: "watch" });
        expect(createdChokidarWatchers[0]?.add).not.toHaveBeenCalled();
        expect(memoryLoggerWarn).toHaveBeenCalledWith(
          `memory ${platform === "linux" ? "Linux" : "native"} parent watcher could not start on ${workspaceDir}: Error: simulated native fs.watch creation failure`,
        );
      },
    );

    it.each([false, true])(
      "does not restore watches after closure with root missing=%s",
      async (missing) => {
        const { activeManager, dir, main, parent, sync } =
          await setupParentWatchLifecycle(platform);
        await fs.rename(dir, path.join(workspaceDir, "previous-memory"));
        if (missing) {
          parent.emit("rename", "memory");
        }
        await activeManager.close();
        const nativeCalls = nativeWatchMock.mock.calls.length;
        const chokidarCalls = watchMock.mock.calls.length;
        await fs.mkdir(dir);

        parent.emit("rename", "memory");
        main.emitError(new Error("late native error"));
        await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);

        expect(nativeWatchMock).toHaveBeenCalledTimes(nativeCalls);
        expect(watchMock).toHaveBeenCalledTimes(chokidarCalls);
        expect(createdChokidarWatchers[0]?.add).not.toHaveBeenCalled();
        expect(sync).not.toHaveBeenCalled();
        expect(main.close).toHaveBeenCalledTimes(1);
        expect(parent.close).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("settles changed file stats before running watch sync", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    const activeManager = await expectWatcherManager(cfg);
    vi.useFakeTimers();
    const notesPath = path.join(extraDir, "notes.md");
    const initialStats = await fs.stat(notesPath);
    const syncSpy = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);

    // extraDir is now watched via native fs.watch; emit a change event that
    // resolves to notes.md and confirm settle behavior still applies before
    // the sync is scheduled.
    const extraWatcher = createdNativeWatchers.find((w) => w.dir === extraDir);
    extraWatcher?.emit("change", "notes.md");
    await fs.writeFile(notesPath, "hello updated");

    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
    expect(syncSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
    expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
    // Recorded path should match the resolved absolute path under extraDir.
    const recordedStats = (initialStats as unknown as { isDirectory: () => boolean }).isDirectory();
    expect(typeof recordedStats).toBe("boolean");
  });

  it("attaches a logging non-throwing chokidar error listener", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);

    const chokidarWatcher = createdChokidarWatchers[0];
    const errorRegistration = chokidarWatcher?.on.mock.calls.find(([event]) => event === "error");
    expect(errorRegistration?.[0]).toBe("error");
    expect(errorRegistration?.[1]).toBeTypeOf("function");
    expect(chokidarWatcher?.emit("error", new Error("watcher error: ENOSPC"))).toBeUndefined();
    expect(memoryLoggerWarn).toHaveBeenCalledWith("memory watcher error: watcher error: ENOSPC");
  });

  it("warns when chokidar memory watching tracks many paths", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "memory-watch");
    try {
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const cfg = createWatcherConfig();
      cfg.agents = {
        ownership: "explicit",
        entries: { main: {}, "watch-paths": { workspace: workspaceDir } },
      };
      vi.useFakeTimers();

      const activeManager = await expectWatcherManager(cfg, "watch-paths");

      const chokidarWatcher = createdChokidarWatchers[0];
      if (!chokidarWatcher) {
        throw new Error("expected chokidar watcher");
      }
      chokidarWatcher.watchedEntries = {
        [workspaceDir]: Array.from({ length: 2_001 }, (_value, index) => `${index}.md`),
      };
      expect(memoryLoggerWarn).not.toHaveBeenCalled();
      chokidarWatcher.emit("ready");
      expect(memoryLoggerWarn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await activeManager.close();
      expect(chokidarWatcher.close).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(memoryLoggerWarn).toHaveBeenCalledExactlyOnceWith(
        "Memory file watching is tracking 2002 paths. Large memory folders or extraPaths can make OpenClaw run out of file watchers or open files. Remove unnecessary memory.search.extraPaths entries or narrow their directory roots, including per-agent entries; otherwise review the host's file-watch/open-file limits. After changes, restart the Gateway. To refresh the affected index, run in the Gateway's environment: openclaw --profile memory-watch memory index --force --agent watch-paths.",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

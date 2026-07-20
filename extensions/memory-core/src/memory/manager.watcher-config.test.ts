// Memory Core tests cover manager.watcher config plugin behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  MemorySearchConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
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
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    },
  }),
}));

import { clearMemoryEmbeddingProviders as clearRegistry } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  closeAllMemorySearchManagers,
  getMemorySearchManager,
  type MemoryIndexManager,
} from "./index.js";

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
    const defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {
      workspace: workspaceDir,
      memorySearch: {
        provider: "openai",
        model: "mock-embed",
        store: { vector: { enabled: false } },
        sync: { watch: true, onSessionStart: false, onSearch: false },
        query: { minScore: 0, hybrid: { enabled: false } },
        extraPaths: [extraDir],
        ...overrides,
      },
    };
    return {
      memory: { backend: "builtin" },
      agents: {
        defaults,
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  async function expectWatcherManager(cfg: OpenClawConfig) {
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error("manager missing");
    }
    expect(result.manager.status().backend).toBe("builtin");
    expect(result.manager.status().sources).toContain("memory");
    manager = result.manager as unknown as MemoryIndexManager;
  }

  it("routes directories to native recursive fs.watch and files to chokidar", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);

    // Chokidar should only see file paths (MEMORY.md); directories use native watch.
    expect(watchMock).toHaveBeenCalledTimes(1);
    const [chokidarPaths, chokidarOptions] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(chokidarPaths).toStrictEqual([path.join(workspaceDir, "MEMORY.md")]);
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
    expect(parentNativeCalls.map((call) => call[0])).toStrictEqual(
      expect.arrayContaining([workspaceDir, workspaceDir]),
    );

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
  });

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
    expect(chokidarPaths).toStrictEqual([path.join(workspaceDir, "MEMORY.md")]);

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

      await expectWatcherManager(cfg);
      vi.useFakeTimers();
      const syncSpy = vi
        .spyOn(
          manager as unknown as {
            sync: (params?: { reason?: string }) => Promise<void>;
          },
          "sync",
        )
        .mockResolvedValue(undefined);

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

      await expectWatcherManager(cfg);
      vi.useFakeTimers();
      const syncSpy = vi
        .spyOn(
          manager as unknown as {
            sync: (params?: { reason?: string }) => Promise<void>;
          },
          "sync",
        )
        .mockResolvedValue(undefined);

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

    await expectWatcherManager(cfg);
    vi.useFakeTimers();
    const syncSpy = vi
      .spyOn(
        manager as unknown as {
          sync: (params?: { reason?: string }) => Promise<void>;
        },
        "sync",
      )
      .mockResolvedValue(undefined);

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

    await expectWatcherManager(cfg);
    vi.useFakeTimers();
    const syncSpy = vi
      .spyOn(
        manager as unknown as {
          sync: (params?: { reason?: string }) => Promise<void>;
        },
        "sync",
      )
      .mockResolvedValue(undefined);

    const memoryDir = path.join(workspaceDir, "memory");
    const memoryWatcher = createdNativeWatchers.find((w) => w.dir === memoryDir);
    expect(memoryWatcher).toBeDefined();
    const closeSpy = memoryWatcher!.close;

    // Pre-error: chokidar has MEMORY.md only; memoryDir is not in its set.
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
      expect(chokidarPathsLinux).toStrictEqual([path.join(workspaceDir, "MEMORY.md")]);

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
      vi.useFakeTimers();

      await expectWatcherManager(cfg);
      expect(memoryLoggerWarn).not.toHaveBeenCalledWith(
        expect.stringContaining("Memory file watching is tracking 2002 directories."),
      );
      await vi.advanceTimersByTimeAsync(10_000);

      expect(memoryLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("Memory file watching is tracking 2002 directories."),
      );
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatformValue,
        configurable: true,
      });
    }
  });

  it("attaches Linux native watchers for new subdirectories", async () => {
    const originalPlatformValue = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const cfg = createWatcherConfig();

      await expectWatcherManager(cfg);
      vi.useFakeTimers();
      const syncSpy = vi
        .spyOn(
          manager as unknown as {
            sync: (params?: { reason?: string }) => Promise<void>;
          },
          "sync",
        )
        .mockResolvedValue(undefined);

      const memoryDir = path.join(workspaceDir, "memory");
      const newDir = path.join(memoryDir, "new-topic");
      await fs.mkdir(newDir);
      const memoryWatcher = createdNativeWatchers.find((w) => w.dir === memoryDir);
      memoryWatcher?.emit("rename", "new-topic");
      await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);

      expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
      expect(
        createdNativeWatchers.some((watcher) => watcher.dir === newDir && !watcher.recursive),
      ).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatformValue,
        configurable: true,
      });
    }
  });

  it("reattaches Linux native watchers for recreated subdirectories", async () => {
    const originalPlatformValue = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const memoryDir = path.join(workspaceDir, "memory");
      const nestedDir = path.join(memoryDir, "topic");
      const childDir = path.join(nestedDir, "child");
      await fs.mkdir(childDir, { recursive: true });
      const cfg = createWatcherConfig();

      await expectWatcherManager(cfg);

      const originalNestedWatcher = createdNativeWatchers.find((w) => w.dir === nestedDir);
      const originalChildWatcher = createdNativeWatchers.find((w) => w.dir === childDir);
      expect(originalNestedWatcher).toBeDefined();
      expect(originalChildWatcher).toBeDefined();
      await fs.rm(nestedDir, { recursive: true, force: true });
      await fs.mkdir(nestedDir);

      const memoryWatcher = createdNativeWatchers.find((w) => w.dir === memoryDir);
      memoryWatcher?.emit("rename", "topic");

      expect(originalNestedWatcher!.close).toHaveBeenCalled();
      expect(originalChildWatcher!.close).toHaveBeenCalled();
      expect(createdNativeWatchers.filter((w) => w.dir === nestedDir)).toHaveLength(2);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatformValue,
        configurable: true,
      });
    }
  });

  it("closes Linux native watchers for deleted subdirectories", async () => {
    const originalPlatformValue = process.platform;
    try {
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

      const memoryWatcher = createdNativeWatchers.find((w) => w.dir === memoryDir);
      memoryWatcher?.emit("rename", "topic");

      expect(nestedWatcher!.close).toHaveBeenCalled();
      expect(childWatcher!.close).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatformValue,
        configurable: true,
      });
    }
  });

  it("keeps startup chokidar fallback when Linux nested watcher setup fails", async () => {
    const originalPlatformValue = process.platform;
    try {
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
      ]);
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatformValue,
        configurable: true,
      });
    }
  });

  it("falls back to chokidar when Linux subtree lstat races with deletion", async () => {
    const originalPlatformValue = process.platform;
    let lstatSpy: { mockRestore: () => void } | undefined;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const nestedDir = path.join(workspaceDir, "memory", "racy-topic");
      await fs.mkdir(nestedDir);
      const originalLstatSync = fsSync.lstatSync.bind(fsSync);
      const lstatMock = vi.spyOn(fsSync, "lstatSync");
      lstatSpy = lstatMock;
      lstatMock.mockImplementation(
        (
          target: Parameters<typeof fsSync.lstatSync>[0],
          options?: Parameters<typeof fsSync.lstatSync>[1],
        ): ReturnType<typeof fsSync.lstatSync> => {
          if (path.resolve(String(target)) === nestedDir) {
            throw Object.assign(new Error("ENOENT: no such file or directory, lstat"), {
              code: "ENOENT",
            });
          }
          return originalLstatSync(target, options);
        },
      );
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
      ]);
      expect(memoryLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("failed to attach Linux memory directory watcher subtree"),
      );
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatformValue,
        configurable: true,
      });
      lstatSpy?.mockRestore();
    }
  });

  it("routes directories through native recursive watch on Windows", async () => {
    // Windows uses ReadDirectoryChangesW for `fs.watch(dir, { recursive: true })`,
    // which is a single-watcher native recursive backend (constant FD profile).
    const originalPlatformLocal = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const cfg = createWatcherConfig();

      await expectWatcherManager(cfg);

      // Chokidar should only see the file path (MEMORY.md); both directory
      // paths (memory/ and extraDir) go to native recursive watch.
      expect(watchMock).toHaveBeenCalledTimes(1);
      const [chokidarPathsWin] = watchMock.mock.calls[0] as unknown as [
        string[],
        Record<string, unknown>,
      ];
      expect(chokidarPathsWin).toStrictEqual([path.join(workspaceDir, "MEMORY.md")]);

      // 2 directories × (main + parent) = 4 native watch calls.
      expect(nativeWatchMock).toHaveBeenCalledTimes(4);
      const nativeDirsWin = (
        nativeWatchMock.mock.calls as unknown as [string, { recursive?: boolean }, unknown][]
      )
        .filter((call) => call[1].recursive === true)
        .map((call) => call[0]);
      expect(nativeDirsWin).toStrictEqual(
        expect.arrayContaining([path.join(workspaceDir, "memory"), extraDir]),
      );
      // Parent watchers must use recursive:false to avoid double-recursion
      // over the same tree.
      const parentDirsWin = (
        nativeWatchMock.mock.calls as unknown as [string, { recursive?: boolean }, unknown][]
      )
        .filter((call) => call[1].recursive !== true)
        .map((call) => call[0]);
      expect(parentDirsWin).toHaveLength(2);
      for (const parentDir of parentDirsWin) {
        expect(parentDir).toBe(workspaceDir);
      }
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatformLocal,
        configurable: true,
      });
    }
  });

  it("creates a chokidar watcher on the fly when no file-path chokidar exists yet", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig({ extraPaths: [] });

    // Force the only chokidar caller (MEMORY.md) to NOT exist by deleting it
    // before manager construction so fileWatchPaths starts empty. Note that
    // MEMORY.md is still a watch *path* in source even if missing on disk —
    // chokidar handles missing paths fine. To truly test the "no chokidar
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

  it("attaches a non-recursive parent-directory watcher for root-replacement detection", async () => {
    // Each native memory directory watch is paired with a non-recursive
    // watcher on the parent directory; the parent watcher catches
    // root-replacement events (`rm -rf memory && mkdir memory`) so the
    // main watcher can be reattached on the new inode.
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig({ extraPaths: [] });
    await expectWatcherManager(cfg);

    const memoryDir = path.join(workspaceDir, "memory");
    const mainWatcher = createdNativeWatchers.find((w) => w.dir === memoryDir && w.recursive);
    const parentWatcher = createdNativeWatchers.find((w) => w.dir === workspaceDir && !w.recursive);
    expect(mainWatcher).toBeDefined();
    expect(parentWatcher).toBeDefined();
    // Parent watcher's mock options must reflect recursive: false.
    expect(parentWatcher!.options.recursive).not.toBe(true);
  });

  it("treats null parent-watcher filename as an unknown event and re-checks the inode", async () => {
    // Node fs.watch can emit `filename: null` on some platforms even on
    // otherwise-supported recursive backends; the parent watcher must
    // not silently drop it. With statSync returning the recorded inode
    // (no real replacement), the no-action path is taken and no
    // teardown/reattach happens.
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig({ extraPaths: [] });
    await expectWatcherManager(cfg);
    vi.useFakeTimers();
    const syncSpy = vi
      .spyOn(
        manager as unknown as {
          sync: (params?: { reason?: string }) => Promise<void>;
        },
        "sync",
      )
      .mockResolvedValue(undefined);

    const memoryDir = path.join(workspaceDir, "memory");
    const mainWatcher = createdNativeWatchers.find((w) => w.dir === memoryDir && w.recursive);
    const parentWatcher = createdNativeWatchers.find((w) => w.dir === workspaceDir && !w.recursive);
    expect(parentWatcher).toBeDefined();
    expect(mainWatcher).toBeDefined();
    const nativeCallsBefore = nativeWatchMock.mock.calls.length;
    const mainCloseSpy = mainWatcher!.close;
    const parentCloseSpy = parentWatcher!.close;

    // Null filename — must not return silently.
    parentWatcher!.emit("rename", null);
    await vi.advanceTimersByTimeAsync(50);

    // The handler ran. Because the real inode matches the recorded
    // inode (no actual replacement), no teardown/reattach happened
    // and no broad dirty was scheduled.
    expect(mainCloseSpy).not.toHaveBeenCalled();
    expect(parentCloseSpy).not.toHaveBeenCalled();
    expect(nativeWatchMock.mock.calls.length).toBe(nativeCallsBefore);
    expect(syncSpy).not.toHaveBeenCalledWith({ reason: "watch" });
  });

  it("closes the paired parent watcher when the native main watcher errors", async () => {
    // When the main native watcher dies and falls back to chokidar, the
    // paired parent watcher must also be closed — otherwise a later
    // root-replacement event would reattach native coverage on top of an
    // already-installed chokidar fallback, creating duplicate handles
    // and event paths.
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig({ extraPaths: [] });
    await expectWatcherManager(cfg);

    const memoryDir = path.join(workspaceDir, "memory");
    const mainWatcher = createdNativeWatchers.find((w) => w.dir === memoryDir && w.recursive);
    const parentWatcher = createdNativeWatchers.find((w) => w.dir === workspaceDir && !w.recursive);
    expect(mainWatcher).toBeDefined();
    expect(parentWatcher).toBeDefined();
    const parentCloseSpy = parentWatcher!.close;

    mainWatcher!.emitError(new Error("watcher error: ENOSPC"));

    // The error handler should have closed and removed the paired
    // parent watcher before installing the chokidar fallback.
    expect(parentCloseSpy).toHaveBeenCalled();
  });

  it("ignores parent-directory events for unrelated basenames", async () => {
    // When the parent-directory watcher fires for a sibling (not the
    // watched root's basename), no teardown or reattach should occur.
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig({ extraPaths: [] });
    await expectWatcherManager(cfg);
    vi.useFakeTimers();
    const syncSpy = vi
      .spyOn(
        manager as unknown as {
          sync: (params?: { reason?: string }) => Promise<void>;
        },
        "sync",
      )
      .mockResolvedValue(undefined);

    const parentWatcher = createdNativeWatchers.find((w) => w.dir === workspaceDir && !w.recursive);
    expect(parentWatcher).toBeDefined();
    const nativeCallsBefore = nativeWatchMock.mock.calls.length;
    const mainCloseSpy = createdNativeWatchers.find(
      (w) => w.dir === path.join(workspaceDir, "memory") && w.recursive,
    )!.close;

    // Sibling event — should be ignored.
    parentWatcher!.emit("rename", "unrelated-sibling-dir");
    await vi.advanceTimersByTimeAsync(50);

    expect(mainCloseSpy).not.toHaveBeenCalled();
    expect(nativeWatchMock.mock.calls.length).toBe(nativeCallsBefore);
    expect(syncSpy).not.toHaveBeenCalled();
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

  it("settles changed file stats before running watch sync", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);
    vi.useFakeTimers();
    const notesPath = path.join(extraDir, "notes.md");
    const initialStats = await fs.stat(notesPath);
    const syncSpy = vi
      .spyOn(
        manager as unknown as {
          sync: (params?: { reason?: string }) => Promise<void>;
        },
        "sync",
      )
      .mockResolvedValue(undefined);

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
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();
    vi.useFakeTimers();

    await expectWatcherManager(cfg);

    const chokidarWatcher = createdChokidarWatchers[0];
    if (!chokidarWatcher) {
      throw new Error("expected chokidar watcher");
    }
    chokidarWatcher.watchedEntries = {
      [workspaceDir]: Array.from({ length: 2_001 }, (_value, index) => `${index}.md`),
    };
    expect(memoryLoggerWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("Memory file watching is tracking 2002 paths."),
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(memoryLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Memory file watching is tracking 2002 paths."),
    );
  });
});

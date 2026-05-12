import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  MemorySearchConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WatchIgnoredFn = (watchPath: string, stats?: { isDirectory?: () => boolean }) => boolean;

const { createdWatchers, memoryLoggerWarn, watchMock } = vi.hoisted(() => {
  type WatchEvent = "add" | "change" | "unlink" | "unlinkDir" | "error";
  type WatchCallback = (value?: unknown) => void;
  function createMockWatcher() {
    const handlers = new Map<WatchEvent, WatchCallback[]>();
    const watcher = {
      on: vi.fn((event: WatchEvent, callback: WatchCallback) => {
        handlers.set(event, [...(handlers.get(event) ?? []), callback]);
        return watcher;
      }),
      close: vi.fn(async () => undefined),
      emit: (event: WatchEvent, value?: unknown) => {
        for (const callback of handlers.get(event) ?? []) {
          callback(value);
        }
      },
    };
    return watcher;
  }
  const watchers: Array<ReturnType<typeof createMockWatcher>> = [];
  const result = {
    createdWatchers: watchers,
    memoryLoggerWarn: vi.fn(),
    watchMock: vi.fn(() => {
      const watcher = createMockWatcher();
      watchers.push(watcher);
      return watcher;
    }),
  };
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.test.memoryWatchFactory")] =
    result.watchMock;
  return result;
});

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

import {
  clearMemoryEmbeddingProviders as clearRegistry,
  registerMemoryEmbeddingProvider as registerAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  closeAllMemorySearchManagers,
  getMemorySearchManager,
  type MemoryIndexManager,
} from "./index.js";
import { registerBuiltInMemoryEmbeddingProviders } from "./provider-adapters.js";

describe("memory watcher config", () => {
  let manager: MemoryIndexManager | null = null;
  let workspaceDir = "";
  let extraDir = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    clearRegistry();
    registerBuiltInMemoryEmbeddingProviders({ registerMemoryEmbeddingProvider: registerAdapter });
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, Symbol.for("openclaw.test.memoryWatchFactory"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    watchMock.mockClear();
    createdWatchers.length = 0;
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    clearRegistry();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
      extraDir = "";
    }
  });

  async function setupWatcherWorkspace(seedFile: { name: string; contents: string }) {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-"));
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
        store: { path: path.join(workspaceDir, "index.sqlite"), vector: { enabled: false } },
        sync: { watch: true, watchDebounceMs: 25, onSessionStart: false, onSearch: false },
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

  it("watches the memory directory and ignores non-markdown churn", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);

    expect(watchMock).toHaveBeenCalledTimes(1);
    const [watchedPaths, options] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(watchedPaths).toStrictEqual([
      path.join(workspaceDir, "MEMORY.md"),
      path.join(workspaceDir, "memory"),
      extraDir,
    ]);
    expect(watchedPaths.every((watchedPath) => !watchedPath.includes("*"))).toBe(true);
    expect(options.ignoreInitial).toBe(true);
    expect(options.awaitWriteFinish).toEqual({ stabilityThreshold: 25, pollInterval: 100 });

    const ignored = options.ignored as WatchIgnoredFn | undefined;
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
  });

  it("watches multimodal extra directories with filtered extensions", async () => {
    await setupWatcherWorkspace({ name: "PHOTO.PNG", contents: "png" });
    const cfg = createWatcherConfig({
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
      multimodal: { enabled: true, modalities: ["image", "audio"] },
    });

    await expectWatcherManager(cfg);

    expect(watchMock).toHaveBeenCalledTimes(1);
    const [watchedPaths, options] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(watchedPaths).toStrictEqual([
      path.join(workspaceDir, "MEMORY.md"),
      path.join(workspaceDir, "memory"),
      extraDir,
    ]);
    expect(watchedPaths.every((watchedPath) => !watchedPath.includes("*"))).toBe(true);

    const ignored = options.ignored as WatchIgnoredFn | undefined;
    expect(ignored).toBeTypeOf("function");
    expect(ignored?.(path.join(extraDir, "nested", "PHOTO.PNG"))).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "PHOTO.PNG"), {})).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "voice.WAV"))).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "voice.WAV"), {})).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "metadata.json"), {})).toBe(true);
  });

  it.each(["add", "change", "unlink", "unlinkDir"] as const)(
    "schedules watch sync on %s",
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

      createdWatchers[0]?.emit(event);
      await vi.advanceTimersByTimeAsync(25);

      expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
    },
  );

  it("attaches a logging non-throwing watcher error listener", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);

    const watcher = createdWatchers[0];
    const errorRegistration = watcher?.on.mock.calls.find(([event]) => event === "error");
    expect(errorRegistration?.[0]).toBe("error");
    expect(errorRegistration?.[1]).toBeTypeOf("function");
    expect(watcher?.emit("error", new Error("watcher error: ENOSPC"))).toBeUndefined();
    expect(memoryLoggerWarn).toHaveBeenCalledWith("memory watcher error: watcher error: ENOSPC");
  });
});

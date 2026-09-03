// Memory Core tests cover kernel watch capacity exhaustion degrade behavior.
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

const {
  capacityCode: capacityOverride,
  createdChokidarWatchers,
  memoryLoggerWarn,
  nativeWatchMock: nativeWatchFactoryMock,
} = vi.hoisted(() => {
  const chokidarKey = Symbol.for("openclaw.test.memoryWatchFactory");
  const nativeKey = Symbol.for("openclaw.test.memoryNativeWatchFactory");
  const chokidarWatchers: Array<Record<string, unknown>> = [];
  const watchMock = vi.fn(() => {
    const watcher = {
      on: vi.fn(() => watcher),
      once: vi.fn(() => watcher),
      add: vi.fn(() => watcher),
      close: vi.fn(async () => undefined),
      getWatched: vi.fn(() => ({})),
    };
    chokidarWatchers.push(watcher);
    return watcher;
  });
  // EMFILE from inotify_init1 / watch-instance exhaustion: Node surfaces it as
  // an Error whose `code` is the errno name, thrown synchronously by fs.watch.
  const capacityCode = { current: null as string | null };
  const nativeWatchMock = vi.fn((dir: string) => {
    if (capacityCode.current) {
      throw Object.assign(new Error(`simulated watch failure on ${dir}`), {
        code: capacityCode.current,
      });
    }
    const errorHandlers: Array<(err: Error) => void> = [];
    const watcher = {
      dir,
      on: vi.fn((event: "error", callback: (err: Error) => void) => {
        if (event === "error") {
          errorHandlers.push(callback);
        }
        return watcher;
      }),
      close: vi.fn(() => undefined),
    };
    return watcher;
  });
  const result = {
    createdChokidarWatchers: chokidarWatchers,
    memoryLoggerWarn: vi.fn(),
    watchMock,
    nativeWatchMock,
    capacityCode,
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

describe("memory watcher kernel capacity degrade", () => {
  let manager: MemoryIndexManager | null = null;
  let workspaceDir = "";
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
    vi.clearAllMocks();
    createdChokidarWatchers.length = 0;
    capacityOverride.current = null;
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, CHOKIDAR_FACTORY_KEY);
    Reflect.deleteProperty(globalThis, NATIVE_FACTORY_KEY);
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    clearRegistry();
    restoreWatcherStateDir();
    closeOpenClawAgentDatabasesForTest();
    resetPluginStateStoreForTests();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
    }
  });

  async function setupCapacityWorkspace() {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-capacity-"));
    setWatcherStateDir(path.join(workspaceDir, "state"));
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory", "note.md"), "hello");
  }

  function createWatchConfig(overrides?: Partial<MemorySearchConfig>): OpenClawConfig {
    const defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {
      workspace: workspaceDir,
    };
    return isolateMemoryManagerTestConfig({
      memory: {
        backend: "builtin",
        search: {
          provider: "openai",
          model: "mock-embed",
          store: { vector: { enabled: false } },
          sync: { watch: true, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
          ...overrides,
        },
      },
      agents: {
        defaults,
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig);
  }

  async function createManager(cfg: OpenClawConfig) {
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error("manager missing");
    }
    // SAFETY: test-only narrowing to the concrete manager class, mirroring manager.watcher-config.test.ts.
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  function readIntervalTimer(active: MemoryIndexManager): NodeJS.Timeout | null {
    // SAFETY: test-only read of the protected intervalTimer field to assert the polling degrade started.
    return (active as unknown as { intervalTimer: NodeJS.Timeout | null }).intervalTimer;
  }

  it.each([
    ["linux", "EMFILE"],
    ["darwin", "EMFILE"],
  ] as const)(
    "%s root watch EMFILE skips the chokidar fallback and degrades to interval sync",
    async (platform, code) => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      await setupCapacityWorkspace();
      capacityOverride.current = code;

      const active = await createManager(createWatchConfig());

      await vi.waitFor(() => expect(nativeWatchFactoryMock).toHaveBeenCalled());
      // The per-file chokidar fallback cannot succeed under the same kernel
      // limit, so no chokidar watcher may be created at all.
      expect(createdChokidarWatchers).toHaveLength(0);
      const warned = memoryLoggerWarn.mock.calls.some((call) =>
        String(call[0]).includes("kernel watch capacity exhausted"),
      );
      expect(warned).toBe(true);
      expect(readIntervalTimer(active)).toBeTruthy();
    },
  );

  it("linux non-capacity native failure still falls back to chokidar", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupCapacityWorkspace();
    // A plain failure (e.g. transient unsupported FS) must keep the existing
    // chokidar fallback so directory coverage is not silently dropped.
    nativeWatchFactoryMock.mockImplementationOnce(() => {
      throw new Error("simulated native fs.watch creation failure");
    });

    await createManager(createWatchConfig());

    await vi.waitFor(() => expect(createdChokidarWatchers.length).toBeGreaterThan(0));
    expect(createdChokidarWatchers.length).toBeGreaterThan(0);
  });

  it("capacity polling re-dirties the index on every interval tick", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupCapacityWorkspace();
    capacityOverride.current = "EMFILE";
    vi.useFakeTimers();

    const active = await createManager(createWatchConfig());
    await vi.waitFor(() => expect(readIntervalTimer(active)).toBeTruthy());

    function readDirty(m: MemoryIndexManager): boolean {
      // SAFETY: test-only read of the protected dirty flag to observe the forced rescan.
      return (m as unknown as { dirty: boolean }).dirty;
    }

    // Simulate the first degraded tick completing a successful full sync,
    // which clears the dirty flag (interval sync is dirty-gated downstream).
    // SAFETY: test-only write to the protected dirty flag.
    (active as unknown as { dirty: boolean }).dirty = false;
    expect(readDirty(active)).toBe(false);

    // Edit a memory file after startup. No watcher exists to mark the index
    // dirty, so the next interval tick must force the rescan itself.
    await fs.writeFile(path.join(workspaceDir, "memory", "late-note.md"), "late content");

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(readDirty(active)).toBe(true);
  });
});

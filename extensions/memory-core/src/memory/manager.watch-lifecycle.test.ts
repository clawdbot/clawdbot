// Memory Core tests cover watcher-to-lifecycle maintenance handoff and teardown.
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

const BUILT_IN_WATCH_DEBOUNCE_MS = 1_500;
const LIFECYCLE_INITIAL_RECONCILE_DELAY_MS = 60_000;
const LIFECYCLE_SAFETY_SWEEP_INTERVAL_MS = 5 * 60_000;
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
import { createMemoryWatchTestHarness } from "./manager.watcher-test-support.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

const watcherHarness = createMemoryWatchTestHarness();
const { createdNativeWatchers } = watcherHarness;

describe("memory watcher lifecycle", () => {
  let manager: MemoryIndexManager | null = null;
  let workspaceDir = "";
  let extraDir = "";
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    watcherHarness.install();
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.clearAllMocks();
    clearRegistry();
    watcherHarness.reset();
  });

  afterAll(() => {
    watcherHarness.uninstall();
  });

  afterEach(async () => {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    watcherHarness.reset();
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
          rememberAcrossConversations: false,
          sources: ["memory"],
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
    expect(result.manager.status().sources).toEqual(["memory"]);
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  async function waitForLifecycleSafetySweep(activeManager: MemoryIndexManager): Promise<void> {
    const pending = Reflect.get(activeManager, "lifecycleSafetySweep") as Promise<void> | null;
    await pending;
  }

  it("reconciles initial dirty state outside interactive search", async () => {
    vi.useFakeTimers();
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const activeManager = await expectWatcherManager(createWatcherConfig());
    const syncSpy = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);

    await vi.advanceTimersByTimeAsync(LIFECYCLE_INITIAL_RECONCILE_DELAY_MS - 1);
    expect(syncSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await waitForLifecycleSafetySweep(activeManager);
    expect(syncSpy).toHaveBeenCalledExactlyOnceWith({ reason: "sweep" });
  });

  it("lets an in-flight watcher settle before lifecycle reconciliation", async () => {
    vi.useFakeTimers();
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const activeManager = await expectWatcherManager(createWatcherConfig());
    const extraWatcher = createdNativeWatchers.find(
      (watcher) => watcher.dir === extraDir && watcher.recursive,
    );
    expect(extraWatcher).toBeDefined();
    const startupWatchTimer = Reflect.get(activeManager, "watchTimer") as NodeJS.Timeout | null;
    if (startupWatchTimer) {
      clearTimeout(startupWatchTimer);
      Reflect.set(activeManager, "watchTimer", null);
    }
    const syncSpy = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);

    await vi.advanceTimersByTimeAsync(
      LIFECYCLE_INITIAL_RECONCILE_DELAY_MS - BUILT_IN_WATCH_DEBOUNCE_MS - 50,
    );
    extraWatcher?.emit("rename", "late.md");
    await fs.writeFile(path.join(extraDir, "late.md"), "late but stable");
    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS + 50);

    expect(Reflect.get(activeManager, "watchSyncSettling")).toBe(true);
    expect(syncSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(syncSpy).toHaveBeenCalledExactlyOnceWith({ reason: "watch" });
  });

  it("keeps full-retry recovery on the canonical maintenance path", async () => {
    vi.useFakeTimers();
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const activeManager = await expectWatcherManager(createWatcherConfig());
    Reflect.set(activeManager, "dirty", true);
    Reflect.set(activeManager, "memoryFullRetryDirty", true);
    const directSync = vi.spyOn(activeManager, "sync");
    const fullRetrySync = vi
      .spyOn(
        activeManager as unknown as {
          syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
        },
        "syncPublishedIndexInBackground",
      )
      .mockResolvedValue(undefined);

    await vi.advanceTimersByTimeAsync(LIFECYCLE_INITIAL_RECONCILE_DELAY_MS);
    await waitForLifecycleSafetySweep(activeManager);

    expect(fullRetrySync).toHaveBeenCalledExactlyOnceWith({ reason: "sweep" });
    expect(directSync).not.toHaveBeenCalled();
  });

  it("cancels a queued lifecycle sweep during close", async () => {
    vi.useFakeTimers();
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const activeManager = await expectWatcherManager(createWatcherConfig());
    const syncSpy = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);

    await activeManager.close();
    manager = null;
    expect(Reflect.get(activeManager, "lifecycleSafetySweepTimer")).toBeNull();
    await vi.advanceTimersByTimeAsync(LIFECYCLE_SAFETY_SWEEP_INTERVAL_MS);

    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("waits for an in-flight lifecycle sweep before closing resources", async () => {
    vi.useFakeTimers();
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const activeManager = await expectWatcherManager(createWatcherConfig());
    let releaseSync = () => {};
    const pendingSync = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });
    const syncSpy = vi.spyOn(activeManager, "sync").mockImplementation(async () => {
      await pendingSync;
    });
    const closeFields = activeManager as unknown as {
      closeNativeMemoryWatchPairs: () => void;
    };
    const closeNativeMemoryWatchPairs = closeFields.closeNativeMemoryWatchPairs.bind(activeManager);
    let syncReleased = false;
    const resourceCloseOrder: string[] = [];
    const resourceCloseSpy = vi
      .spyOn(closeFields, "closeNativeMemoryWatchPairs")
      .mockImplementation(() => {
        resourceCloseOrder.push(syncReleased ? "after-sync-release" : "before-sync-release");
        closeNativeMemoryWatchPairs();
      });

    let closeSettled = false;
    let closePromise: Promise<void> | null = null;
    try {
      await vi.advanceTimersByTimeAsync(LIFECYCLE_INITIAL_RECONCILE_DELAY_MS);
      expect(syncSpy).toHaveBeenCalledExactlyOnceWith({ reason: "sweep" });

      closePromise = activeManager.close().then(() => {
        closeSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(closeSettled).toBe(false);
      expect(resourceCloseSpy).not.toHaveBeenCalled();
    } finally {
      syncReleased = true;
      releaseSync();
      if (closePromise) {
        await closePromise;
        manager = null;
      }
    }

    expect(resourceCloseSpy).toHaveBeenCalledTimes(1);
    expect(resourceCloseOrder).toEqual(["after-sync-release"]);
    await vi.advanceTimersByTimeAsync(LIFECYCLE_SAFETY_SWEEP_INTERVAL_MS);
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });
});

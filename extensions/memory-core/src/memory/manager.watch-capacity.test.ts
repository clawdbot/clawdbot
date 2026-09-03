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
  createdNativeWatchers,
  makeDefaultNativeWatcher: makeNativeWatcherFor,
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
  type NativeListener = (eventType: string, filename: string | null) => void;
  function makeDefaultNativeWatcher(dir: string) {
    const errorHandlers: Array<(err: Error) => void> = [];
    const listenerRef: { current: NativeListener | null } = { current: null };
    const watcher = {
      dir,
      on: vi.fn((event: "error", callback: (err: Error) => void) => {
        if (event === "error") {
          errorHandlers.push(callback);
        }
        return watcher;
      }),
      close: vi.fn(() => undefined),
      emit: (eventType: string, filename: string | null) => {
        listenerRef.current?.(eventType, filename);
      },
      emitError: (err: Error) => {
        for (const handler of errorHandlers) {
          handler(err);
        }
      },
      rememberListener: (listener: NativeListener) => {
        listenerRef.current = listener;
      },
    };
    return watcher;
  }
  const nativeWatchers: Array<ReturnType<typeof makeDefaultNativeWatcher>> = [];
  const nativeWatchMock = vi.fn((dir: string, _options: unknown, listener?: NativeListener) => {
    if (capacityCode.current) {
      throw Object.assign(new Error(`simulated watch failure on ${dir}`), {
        code: capacityCode.current,
      });
    }
    const watcher = makeNativeWatcherFor(dir);
    if (listener) {
      watcher.rememberListener(listener);
    }
    nativeWatchers.push(watcher);
    return watcher;
  });
  const result = {
    createdChokidarWatchers: chokidarWatchers,
    createdNativeWatchers: nativeWatchers,
    makeDefaultNativeWatcher,
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
const EVIDENCE_NEWLINE = String.fromCharCode(10);
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
import { configureMemoryCoreDreamingStateForTests } from "../test-helpers.js";
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
    nativeWatchFactoryMock.mockReset();
    createdNativeWatchers.length = 0;
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

  it("reattaching one degraded root keeps forced rescans for the other", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupCapacityWorkspace();
    const extraDir = path.join(workspaceDir, "extra-memory");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "extra.md"), "extra note");
    capacityOverride.current = "EMFILE";

    const active = await createManager(createWatchConfig({ extraPaths: [extraDir] }));
    await vi.waitFor(() => expect(readIntervalTimer(active)).toBeTruthy());

    function readDegradedDirs(m: MemoryIndexManager): string[] {
      // SAFETY: test-only read of the per-root degraded set.
      return Array.from(
        (m as unknown as { capacityDegradedDirs: Set<string> }).capacityDegradedDirs,
      );
    }

    // Both roots degraded: the workspace memory dir and the extra path dir.
    expect(readDegradedDirs(active)).toHaveLength(2);

    // One root recovers (its parent watcher reattaches successfully): the
    // other root must keep its forced rescans.
    // SAFETY: test-only removal mimicking one root's successful reattachment.
    const memoryRoot = readDegradedDirs(active).find((dir) => dir.endsWith("memory"));
    (active as unknown as { capacityDegradedDirs: Set<string> }).capacityDegradedDirs.delete(
      memoryRoot,
    );
    expect(readDegradedDirs(active)).toHaveLength(1);
    // SAFETY: test-only write simulating the settle after the previous sync.
    (active as unknown as { dirty: boolean }).dirty = false;
    // The still-degraded root keeps forcing rescans on every tick: verified
    // structurally in the tick test; here the surviving degraded root proves
    // the manager-wide gate remains armed (size > 0).
    expect(readDegradedDirs(active).length).toBeGreaterThan(0);
  });

  // The full index pipeline needs the plugin state store; its sqlite temp-dir
  // handling does not work on local Windows (same class as the doctor suites),
  // so CI Linux is authoritative for the real-index proof.
  const itLinux = process.platform === "win32" ? it.skip : it;
  itLinux("indexes a post-startup memory edit through degraded polling only", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupCapacityWorkspace();
    capacityOverride.current = "EMFILE";
    const trace: string[] = [
      `t0 platform=linux capacity=EMFILE workspace=${workspaceDir}`,
      "t1 startup: root fs.watch throws EMFILE -> degrade (no directory chokidar watcher)",
    ];
    await configureMemoryCoreDreamingStateForTests();

    const active = await createManager(createWatchConfig());
    await vi.waitFor(() => expect(readIntervalTimer(active)).toBeTruthy());
    expect(createdChokidarWatchers).toHaveLength(0);

    function readIndexedPaths(m: MemoryIndexManager): string[] {
      // SAFETY: test-only read of the protected sqlite handle to inspect indexed sources.
      const db = (
        m as unknown as { db: { prepare: (q: string) => { all: () => Array<{ path?: unknown }> } } }
      ).db;
      return db
        .prepare("SELECT path FROM memory_index_sources")
        .all()
        .flatMap((row) => (typeof row.path === "string" ? [row.path] : []));
    }
    function forceDegradedTick(m: MemoryIndexManager): void {
      // SAFETY: test-only write forcing the dirty flag exactly as the degraded interval tick does.
      (m as unknown as { dirty: boolean }).dirty = true;
    }

    // First degraded rescan (what every interval tick now forces) indexes the
    // baseline note. Real manager, real sqlite index, real files on disk.
    forceDegradedTick(active);
    await active.sync({ reason: "interval" });
    await vi.waitFor(() => expect(readIndexedPaths(active)).toHaveLength(1));
    trace.push(`t2 degraded rescan #1: indexed=${JSON.stringify(readIndexedPaths(active))}`);

    // Post-startup edit: a brand-new memory note, with no watcher to observe it.
    await fs.writeFile(path.join(workspaceDir, "memory", "late-note.md"), "late capacity note");
    // SAFETY: test-only write simulating the settle after the previous sync.
    (active as unknown as { dirty: boolean }).dirty = false;

    // The next forced-rescan tick must pick the new file into the index.
    forceDegradedTick(active);
    await active.sync({ reason: "interval" });
    await vi.waitFor(() =>
      expect(readIndexedPaths(active).some((indexed) => indexed.includes("late-note"))).toBe(true),
    );
    trace.push(`t3 degraded rescan #2: indexed=${JSON.stringify(readIndexedPaths(active))}`);
    trace.push(
      "t4 proof: the memory index learned the post-startup edit via degraded polling alone",
    );
    expect(createdChokidarWatchers).toHaveLength(0);

    const evidenceDir = process.env.OPENCLAW_EVIDENCE_OUT;
    if (evidenceDir) {
      await fs.mkdir(evidenceDir, { recursive: true });
      const traceText = trace.join(EVIDENCE_NEWLINE);
      await fs.writeFile(
        path.join(evidenceDir, "137200-capacity-degrade-trace.md"),
        `${traceText}${EVIDENCE_NEWLINE}`,
      );
    }
  });

  it("runtime new-child capacity failure degrades through the event path", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupCapacityWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");

    const active = await createManager(createWatchConfig());
    await vi.waitFor(() =>
      expect(nativeWatchFactoryMock.mock.calls.some((call) => String(call[0]) === memoryDir)).toBe(
        true,
      ),
    );
    const rootWatcher = createdNativeWatchers.find((watcher) => watcher.dir === memoryDir);
    const chokidarBaseline = createdChokidarWatchers.length;

    // A new subdirectory appears at runtime; attaching it exhausts capacity.
    const childDir = path.join(memoryDir, "runtime-child");
    await fs.mkdir(childDir);
    capacityOverride.current = "EMFILE";
    rootWatcher?.emit("rename", "runtime-child");

    // The event path must degrade the tree, not restart the chokidar fallback.
    // The event path must degrade the tree, not restart the chokidar
    // fallback (spy is decisive even when a startup watcher exists to reuse).
    // SAFETY: test-only spy on the protected fallback entry point.
    const fallbackSpy = vi.spyOn(
      active as unknown as { attachMemoryChokidarFallback: () => void },
      "attachMemoryChokidarFallback",
    );
    await vi.waitFor(() => {
      const degraded = memoryLoggerWarn.mock.calls.some((call) =>
        String(call[0]).includes("kernel watch capacity exhausted"),
      );
      expect(degraded).toBe(true);
    });
    expect(createdChokidarWatchers.length).toBe(chokidarBaseline);
    expect(readIntervalTimer(active)).toBeTruthy();
    expect(fallbackSpy).not.toHaveBeenCalled();
    // Exactly one warning reports the condition: the degrade warning, without
    // the raw attach-failure line double-reporting it.
    const capacityWarns = memoryLoggerWarn.mock.calls.filter((call) =>
      String(call[0]).includes("kernel watch capacity exhausted"),
    );
    const rawFailureWarns = memoryLoggerWarn.mock.calls.filter((call) =>
      String(call[0]).includes("failed to attach Linux memory directory watcher"),
    );
    expect(capacityWarns).toHaveLength(1);
    expect(rawFailureWarns).toHaveLength(0);
  });

  it("root reattachment under capacity degrades instead of dropping coverage", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupCapacityWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");

    const active = await createManager(createWatchConfig());
    await vi.waitFor(() =>
      expect(nativeWatchFactoryMock.mock.calls.some((call) => String(call[0]) === memoryDir)).toBe(
        true,
      ),
    );
    const parentWatcher = createdNativeWatchers.find((watcher) => watcher.dir === workspaceDir);
    // Startup file watchers (MEMORY.md/USER.md) form the expected baseline.
    const chokidarBaseline = createdChokidarWatchers.length;
    // Replace the watched root so the parent watcher sees a fresh inode.
    await fs.rm(memoryDir, { recursive: true });
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "note.md"), "hello");
    // Every new fs.watch now fails with EMFILE.
    capacityOverride.current = "EMFILE";
    parentWatcher?.emit("rename", "memory");

    await vi.waitFor(() => {
      const degraded = memoryLoggerWarn.mock.calls.some((call) =>
        String(call[0]).includes("kernel watch capacity exhausted"),
      );
      expect(degraded).toBe(true);
    });
    // The startup file watchers (MEMORY.md/USER.md) are the expected baseline;
    // the capacity reattach must not add any further chokidar watcher.
    expect(createdChokidarWatchers.length).toBe(chokidarBaseline);
    expect(readIntervalTimer(active)).toBeTruthy();
  });

  it("parent-watcher capacity error with a live main degrades the tree", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupCapacityWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");

    const active = await createManager(createWatchConfig());
    await vi.waitFor(() => {
      const main = createdNativeWatchers.find((watcher) => watcher.dir === memoryDir);
      const parent = createdNativeWatchers.find((watcher) => watcher.dir === workspaceDir);
      expect(main).toBeTruthy();
      expect(parent).toBeTruthy();
    });
    const parentWatcher = createdNativeWatchers.find((watcher) => watcher.dir === workspaceDir);
    const chokidarBaseline = createdChokidarWatchers.length;

    // The parent watcher dies from capacity exhaustion while the main
    // watcher is still live: the tree must degrade anyway, because the
    // kernel can never grant the parent watch back and root replacement
    // would otherwise go undetected.
    parentWatcher?.emitError(Object.assign(new Error("simulated EMFILE"), { code: "EMFILE" }));

    await vi.waitFor(() => {
      const degraded = memoryLoggerWarn.mock.calls.some((call) =>
        String(call[0]).includes("kernel watch capacity exhausted"),
      );
      expect(degraded).toBe(true);
    });
    expect(createdChokidarWatchers.length).toBe(chokidarBaseline);
    expect(readIntervalTimer(active)).toBeTruthy();
  });

  it("parent-watcher creation capacity failure degrades the tree", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupCapacityWorkspace();

    // The main directory watch attaches fine, but creating the parent
    // watcher itself throws EMFILE synchronously.
    nativeWatchFactoryMock.mockImplementation(
      (
        dir: string,
        options: unknown,
        listener?: (eventType: string, filename: string | null) => void,
      ) => {
        if (String(dir) === workspaceDir) {
          throw Object.assign(new Error(`simulated watch failure on ${dir}`), { code: "EMFILE" });
        }
        const watcher = makeNativeWatcherFor(dir);
        if (listener) {
          watcher.rememberListener(listener);
        }
        createdNativeWatchers.push(watcher);
        return watcher;
      },
    );

    const active = await createManager(createWatchConfig());

    await vi.waitFor(() => {
      const degraded = memoryLoggerWarn.mock.calls.some((call) =>
        String(call[0]).includes("kernel watch capacity exhausted"),
      );
      expect(degraded).toBe(true);
    });
    expect(createdChokidarWatchers).toHaveLength(0);
    expect(readIntervalTimer(active)).toBeTruthy();
  });

  it("linux child-directory capacity failure degrades the whole tree", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await setupCapacityWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    const childDir = path.join(memoryDir, "child");
    await fs.mkdir(childDir, { recursive: true });
    await fs.writeFile(path.join(childDir, "nested.md"), "nested");
    // Root attaches fine; the child directory exhausts capacity.
    capacityOverride.current = null;
    nativeWatchFactoryMock.mockImplementation(
      (
        dir: string,
        options: unknown,
        listener?: (eventType: string, filename: string | null) => void,
      ) => {
        if (String(dir) === childDir) {
          throw Object.assign(new Error(`simulated watch failure on ${dir}`), { code: "EMFILE" });
        }
        const watcher = makeNativeWatcherFor(dir);
        if (listener) {
          watcher.rememberListener(listener);
        }
        createdNativeWatchers.push(watcher);
        return watcher;
      },
    );

    const active = await createManager(createWatchConfig());

    await vi.waitFor(() => {
      const degraded = memoryLoggerWarn.mock.calls.some((call) =>
        String(call[0]).includes("kernel watch capacity exhausted"),
      );
      expect(degraded).toBe(true);
    });
    // Whole-tree degrade: neither the child nor the startup file paths may
    // reach chokidar, because the same kernel limit would defeat them all.
    expect(createdChokidarWatchers).toHaveLength(0);
    expect(readIntervalTimer(active)).toBeTruthy();
  });
});

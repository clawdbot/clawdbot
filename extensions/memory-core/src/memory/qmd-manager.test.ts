import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as scheduleNativeTimeout } from "node:timers";
import type { Mock } from "vitest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { logWarnMock, logDebugMock, logInfoMock } = vi.hoisted(() => ({
  logWarnMock: vi.fn(),
  logDebugMock: vi.fn(),
  logInfoMock: vi.fn(),
}));
const { watchMock } = vi.hoisted(() => ({
  watchMock: vi.fn(() => {
    const watcher = new EventEmitter();
    return Object.assign(watcher, {
      close: vi.fn(async () => undefined),
    });
  }),
}));
const { withFileLockMock } = vi.hoisted(() => ({
  withFileLockMock: vi.fn(
    async <T>(_filePath: string, _options: unknown, fn: () => Promise<T>) => await fn(),
  ),
}));
const MEMORY_EMBEDDING_PROVIDERS_KEY = Symbol.for("openclaw.memoryEmbeddingProviders");
const MCPORTER_STATE_KEY = Symbol.for("openclaw.mcporterState");
const QMD_EMBED_QUEUE_KEY = Symbol.for("openclaw.qmdEmbedQueueTail");

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals) => void;
  closeWith: (code?: number | null) => void;
};

function createMockChild(params?: { autoClose?: boolean; closeDelayMs?: number }): MockChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as MockChild;
  child.stdout = stdout;
  child.stderr = stderr;
  child.closeWith = (code = 0) => {
    child.emit("close", code);
  };
  child.kill = () => {
    // Let timeout rejection win in tests that simulate hung QMD commands.
  };
  if (params?.autoClose !== false) {
    const delayMs = params?.closeDelayMs ?? 0;
    if (delayMs <= 0) {
      queueMicrotask(() => {
        child.emit("close", 0);
      });
    } else {
      scheduleNativeTimeout(() => {
        child.emit("close", 0);
      }, delayMs);
    }
  }
  return child;
}

function emitAndClose(
  child: MockChild,
  stream: "stdout" | "stderr",
  data: string,
  code: number = 0,
) {
  queueMicrotask(() => {
    child[stream].emit("data", data);
    child.closeWith(code);
  });
}

function isMcporterCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") {
    return false;
  }
  return /(^|[\\/])mcporter(?:\.cmd)?$/i.test(cmd);
}

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")
  >("openclaw/plugin-sdk/memory-core-host-engine-foundation");
  return {
    ...actual,
    createSubsystemLogger: () => {
      const logger = {
        warn: logWarnMock,
        debug: logDebugMock,
        info: logInfoMock,
        child: () => logger,
      };
      return logger;
    },
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
  watch: watchMock,
}));

vi.mock("openclaw/plugin-sdk/file-lock", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/file-lock")>(
    "openclaw/plugin-sdk/file-lock",
  );
  return {
    ...actual,
    withFileLock: withFileLockMock,
  };
});

import { spawn as mockedSpawn } from "node:child_process";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  requireNodeSqlite,
  resolveMemoryBackendConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { QmdMemoryManager } from "./qmd-manager.js";

const spawnMock = mockedSpawn as unknown as Mock;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
const originalWindowsPath = (process.env as NodeJS.ProcessEnv & { Path?: string }).Path;

describe("QmdMemoryManager", () => {
  let fixtureRoot: string;
  let fixtureCount = 0;
  let tmpRoot: string;
  let workspaceDir: string;
  let stateDir: string;
  let cfg: OpenClawConfig;
  const agentId = "main";
  const openManagers = new Set<QmdMemoryManager>();
  let embedStartupJitterSpy: { mockRestore: () => void } | null = null;

  function seedMemoryEmbeddingProviders(): void {
    (globalThis as Record<PropertyKey, unknown>)[MEMORY_EMBEDDING_PROVIDERS_KEY] = new Map([
      [
        "openai",
        {
          adapter: {
            id: "openai",
            defaultModel: "text-embedding-3-small",
            transport: "remote",
            create: async () => ({ provider: null }),
          },
        },
      ],
    ]);
  }

  function trackManager<T extends QmdMemoryManager | null>(manager: T): T {
    if (manager) {
      openManagers.add(manager);
    }
    return manager;
  }

  async function createManager(params?: { mode?: "full" | "status"; cfg?: OpenClawConfig }) {
    const cfgToUse = params?.cfg ?? cfg;
    const resolved = resolveMemoryBackendConfig({ cfg: cfgToUse, agentId });
    const manager = trackManager(
      await QmdMemoryManager.create({
        cfg: cfgToUse,
        agentId,
        resolved,
        mode: params?.mode ?? "status",
      }),
    );
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }
    return { manager, resolved };
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qmd-manager-test-fixtures-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => createMockChild());
    watchMock.mockClear();
    withFileLockMock.mockClear();
    logWarnMock.mockClear();
    logDebugMock.mockClear();
    logInfoMock.mockClear();
    tmpRoot = path.join(fixtureRoot, `case-${fixtureCount++}`);
    workspaceDir = path.join(tmpRoot, "workspace");
    stateDir = path.join(tmpRoot, "state");
    // Only workspace must exist for configured collection paths; state paths are
    // created lazily by manager code when needed.
    await fs.mkdir(workspaceDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = stateDir;
    // Keep the default Windows path unresolved for most tests so spawn mocks can
    // match the logical package command. Tests that verify wrapper resolution
    // install explicit shim fixtures inline.
    cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: path.join(workspaceDir, "index.sqlite"), vector: { enabled: false } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    seedMemoryEmbeddingProviders();
    embedStartupJitterSpy = vi
      .spyOn(
        QmdMemoryManager.prototype as unknown as {
          resolveEmbedStartupJitterMs: () => number;
        },
        "resolveEmbedStartupJitterMs",
      )
      .mockReturnValue(0);
  });

  afterEach(async () => {
    await Promise.all(
      Array.from(openManagers, async (manager) => {
        await manager.close();
      }),
    );
    openManagers.clear();
    embedStartupJitterSpy?.mockRestore();
    embedStartupJitterSpy = null;
    vi.useRealTimers();
    delete process.env.OPENCLAW_STATE_DIR;
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalPathExt === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = originalPathExt;
    }
    if (originalWindowsPath === undefined) {
      delete (process.env as NodeJS.ProcessEnv & { Path?: string }).Path;
    } else {
      (process.env as NodeJS.ProcessEnv & { Path?: string }).Path = originalWindowsPath;
    }
    delete (globalThis as Record<PropertyKey, unknown>)[MCPORTER_STATE_KEY];
    delete (globalThis as Record<PropertyKey, unknown>)[QMD_EMBED_QUEUE_KEY];
    delete (globalThis as Record<PropertyKey, unknown>)[MEMORY_EMBEDDING_PROVIDERS_KEY];
  });

  it("debounces back-to-back sync calls", async () => {
    const { manager, resolved } = await createManager();

    const baselineCalls = spawnMock.mock.calls.length;

    await manager.sync({ reason: "manual" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 2);

    await manager.sync({ reason: "manual-again" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 2);

    (manager as unknown as { lastUpdateAt: number | null }).lastUpdateAt =
      Date.now() - (resolved.qmd?.update.debounceMs ?? 0) - 10;

    await manager.sync({ reason: "after-wait" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 3);

    await manager.close();
  });

  it("runs a qmd sync once for the first search in a fresh session", async () => {
    cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: path.join(workspaceDir, "index.sqlite"), vector: { enabled: false } },
            sync: { watch: false, onSessionStart: true, onSearch: false },
          },
        },
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (args[0] === "search" || args[0] === "query" || args[0] === "vsearch") {
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      queueMicrotask(() => child.closeWith(0));
      return child;
    });

    const { manager } = await createManager({ mode: "full" });

    await manager.search("hello", { sessionKey: "session-a" });
    await manager.search("hello again", { sessionKey: "session-a" });

    const updateCalls = spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update");
    expect(updateCalls).toHaveLength(1);
  });

  it("does not block first search on session-start sync completion", async () => {
    vi.useFakeTimers();
    cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: path.join(workspaceDir, "index.sqlite"), vector: { enabled: false } },
            sync: { watch: false, onSessionStart: true, onSearch: false },
          },
        },
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        return child;
      }
      if (args[0] === "search" || args[0] === "query" || args[0] === "vsearch") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    const searchPromise = manager.search("hello", { sessionKey: "session-b" });

    await vi.advanceTimersByTimeAsync(500);
    await expect(searchPromise).resolves.toEqual([]);

    (
      releaseUpdate ??
      (() => {
        throw new Error("expected qmd update process to start");
      })
    )();
    await manager.close();
  });

  it("runs qmd sync when watched collection files change", async () => {
    vi.useFakeTimers();
    cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: path.join(workspaceDir, "index.sqlite"), vector: { enabled: false } },
            sync: { watch: true, watchDebounceMs: 25, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });
    expect(watchMock).toHaveBeenCalledTimes(1);
    const watcher = watchMock.mock.results[0]?.value as EventEmitter & { close: Mock };
    const initialUpdateCalls = spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update");
    expect(initialUpdateCalls).toHaveLength(0);

    watcher.emit("change", path.join(workspaceDir, "notes.md"));
    await vi.advanceTimersByTimeAsync(25);

    const updateCalls = spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update");
    expect(updateCalls).toHaveLength(1);

    await manager.close();
  });

  it("runs boot update in background by default", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    expect(releaseUpdate).not.toBeNull();
    (releaseUpdate as (() => void) | null)?.();
    await manager?.close();
  });

  it("skips qmd command side effects in status mode initialization", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "5m", debounceMs: 60_000, onBoot: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "status" });
    expect(spawnMock).not.toHaveBeenCalled();
    await manager?.close();
  });

  it("can be configured to block startup on boot update", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 60_000,
            onBoot: true,
            waitForBootSync: true,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const updateSpawned = createDeferred<void>();
    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        updateSpawned.resolve();
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const createPromise = QmdMemoryManager.create({ cfg, agentId, resolved, mode: "full" });
    await updateSpawned.promise;
    let created = false;
    void createPromise.then(() => {
      created = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(created).toBe(false);
    (releaseUpdate as (() => void) | null)?.();
    const manager = await createPromise;
    await manager?.close();
  });

  it("times out collection bootstrap commands", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 60_000,
            onBoot: false,
            commandTimeoutMs: 15,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return createMockChild({ autoClose: false });
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager?.close();
  });

  it("rebinds sessions collection when existing collection path targets another agent", async () => {
    const devAgentId = "dev";
    const devWorkspaceDir = path.join(tmpRoot, "workspace-dev");
    await fs.mkdir(devWorkspaceDir);
    cfg = {
      ...cfg,
      agents: {
        list: [
          { id: agentId, default: true, workspace: workspaceDir },
          { id: devAgentId, workspace: devWorkspaceDir },
        ],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: devWorkspaceDir, pattern: "**/*.md", name: "workspace" }],
          sessions: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const sessionCollectionName = `sessions-${devAgentId}`;
    const wrongSessionsPath = path.join(stateDir, "agents", agentId, "qmd", "sessions");
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { name: sessionCollectionName, path: wrongSessionsPath, mask: "**/*.md" },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId: devAgentId });
    const manager = trackManager(
      await QmdMemoryManager.create({
        cfg,
        agentId: devAgentId,
        resolved,
        mode: "full",
      }),
    );
    expect(manager).toBeTruthy();
    await manager?.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeSessions = commands.find(
      (args) =>
        args[0] === "collection" && args[1] === "remove" && args[2] === sessionCollectionName,
    );
    expect(removeSessions).toBeDefined();

    const addSessions = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === sessionCollectionName;
    });
    expect(addSessions).toBeDefined();
    expect(addSessions?.[2]).toBe(path.join(stateDir, "agents", devAgentId, "qmd", "sessions"));
  });

  it("avoids destructive rebind when qmd only reports collection names", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          sessions: { enabled: true },
        },
      },
    } as OpenClawConfig;

    const sessionCollectionName = `sessions-${agentId}`;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([`workspace-${agentId}`, sessionCollectionName]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeCalls = commands.filter((args) => args[0] === "collection" && args[1] === "remove");
    expect(removeCalls).toHaveLength(0);

    const addCalls = commands.filter((args) => args[0] === "collection" && args[1] === "add");
    expect(addCalls).toHaveLength(0);
  });

  it("rebinds collection when qmd text output exposes a changed pattern without a path", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          ["workspace-main (qmd://workspace-main/)", "  Pattern:  *.txt", "  Files:    17"].join(
            "\n",
          ),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeCalls = commands.filter(
      (args) => args[0] === "collection" && args[1] === "remove" && args[2] === "workspace-main",
    );
    expect(removeCalls).toHaveLength(1);

    const addCall = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === "workspace-main";
    });
    expect(addCall).toBeDefined();
    expect(addCall?.[2]).toBe(workspaceDir);
    expect(addCall).toContain("**/*.md");
  });

  it("migrates unscoped legacy collections before adding scoped names", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const legacyCollections = new Map<
      string,
      {
        path: string;
        pattern: string;
      }
    >([
      ["memory-root", { path: workspaceDir, pattern: "MEMORY.md" }],
      ["memory-alt", { path: workspaceDir, pattern: "memory.md" }],
      ["memory-dir", { path: path.join(workspaceDir, "memory"), pattern: "**/*.md" }],
    ]);
    const removeCalls: string[] = [];

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify(
            [...legacyCollections.entries()].map(([name, info]) => ({
              name,
              path: info.path,
              mask: info.pattern,
            })),
          ),
        );
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removeCalls.push(name);
        legacyCollections.delete(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const pathArg = args[2] ?? "";
        const name = args[args.indexOf("--name") + 1] ?? "";
        const globIdx = args.indexOf("--glob");
        const maskIdx = args.indexOf("--mask");
        const pattern =
          (globIdx !== -1 ? args[globIdx + 1] : maskIdx !== -1 ? args[maskIdx + 1] : "") ?? "";
        const hasConflict = [...legacyCollections.entries()].some(
          ([existingName, info]) =>
            existingName !== name && info.path === pathArg && info.pattern === pattern,
        );
        if (hasConflict) {
          emitAndClose(child, "stderr", "collection already exists", 1);
          return child;
        }
        legacyCollections.set(name, { path: pathArg, pattern });
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toEqual(["memory-root", "memory-alt", "memory-dir"]);
    expect(legacyCollections.has("memory-root-main")).toBe(true);
    expect(legacyCollections.has("memory-alt-main")).toBe(true);
    expect(legacyCollections.has("memory-dir-main")).toBe(true);
    expect(legacyCollections.has("memory-root")).toBe(false);
    expect(legacyCollections.has("memory-alt")).toBe(false);
    expect(legacyCollections.has("memory-dir")).toBe(false);
  });

  it("rebinds conflicting collection name when path+pattern slot is already occupied", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const listedCollections = new Map<
      string,
      {
        path: string;
        pattern: string;
      }
    >([["memory-root-sonnet", { path: workspaceDir, pattern: "MEMORY.md" }]]);
    const removeCalls: string[] = [];

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify(
            [...listedCollections.entries()].map(([name, info]) => ({
              name,
              path: info.path,
              mask: info.pattern,
            })),
          ),
        );
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removeCalls.push(name);
        listedCollections.delete(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const pathArg = args[2] ?? "";
        const name = args[args.indexOf("--name") + 1] ?? "";
        const globIdx = args.indexOf("--glob");
        const maskIdx = args.indexOf("--mask");
        const pattern =
          (globIdx !== -1 ? args[globIdx + 1] : maskIdx !== -1 ? args[maskIdx + 1] : "") ?? "";
        const hasConflict = [...listedCollections.entries()].some(
          ([existingName, info]) =>
            existingName !== name && info.path === pathArg && info.pattern === pattern,
        );
        if (hasConflict) {
          emitAndClose(child, "stderr", "A collection already exists for this path and pattern", 1);
          return child;
        }
        listedCollections.set(name, { path: pathArg, pattern });
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toContain("memory-root-sonnet");
    expect(listedCollections.has("memory-root-main")).toBe(true);
    expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining("rebinding"));
  });

  it("warns instead of silently succeeding when add conflict metadata is unavailable", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        // Name-only rows do not expose path/mask metadata.
        emitAndClose(child, "stdout", JSON.stringify(["workspace-legacy"]));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "collection already exists", 1);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("qmd collection add skipped for workspace-main"),
    );
  });

  it("migrates unscoped legacy collections from plain-text collection list output", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const removeCalls: string[] = [];
    const addCalls: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          [
            "Collections (3):",
            "",
            "memory-root (qmd://memory-root/)",
            "  Pattern:  MEMORY.md",
            "",
            "memory-alt (qmd://memory-alt/)",
            "  Pattern:  memory.md",
            "",
            "memory-dir (qmd://memory-dir/)",
            "  Pattern:  **/*.md",
            "",
          ].join("\n"),
        );
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        removeCalls.push(args[2] ?? "");
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        addCalls.push(args[args.indexOf("--name") + 1] ?? "");
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toEqual(["memory-root", "memory-alt", "memory-dir"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-alt-main", "memory-dir-main"]);
  });

  it("does not migrate unscoped collections when listed metadata differs", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const differentPath = path.join(tmpRoot, "other-memory");
    await fs.mkdir(differentPath, { recursive: true });
    const removeCalls: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([{ name: "memory-root", path: differentPath, mask: "MEMORY.md" }]),
        );
        return child;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        removeCalls.push(args[2] ?? "");
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).not.toContain("memory-root");
    expect(logDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("qmd legacy collection migration skipped for memory-root"),
    );
  });

  it("times out qmd update during sync when configured", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            updateTimeoutMs: 20,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        return createMockChild({ autoClose: false });
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const createPromise = QmdMemoryManager.create({ cfg, agentId, resolved, mode: "status" });
    await vi.advanceTimersByTimeAsync(0);
    const manager = trackManager(await createPromise);
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }
    const syncPromise = manager.sync({ reason: "manual" });
    const rejected = expect(syncPromise).rejects.toThrow("qmd update timed out after 20ms");
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    await manager.close();
  });

  it("rebuilds managed collections once when qmd update fails with null-byte ENOTDIR", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(
            child,
            "stderr",
            "ENOTDIR: not a directory, open '/tmp/workspace/MEMORY.md^@'",
            1,
          );
          return child;
        }
        queueMicrotask(() => {
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove")
      .map((args) => args[2]);
    const addCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "add")
      .map((args) => args[args.indexOf("--name") + 1]);

    expect(updateCalls).toBe(2);
    expect(removeCalls).toEqual(["memory-root-main", "memory-alt-main", "memory-dir-main"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-alt-main", "memory-dir-main"]);
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("suspected null-byte collection metadata"),
    );

    await manager.close();
  });

  it("rebuilds managed collections once when qmd update fails with null-byte ENOENT", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(
            child,
            "stderr",
            "ENOENT: no such file or directory, open '/tmp/workspace/MEMORY.md\\x00'",
            1,
          );
          return child;
        }
        queueMicrotask(() => {
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove")
      .map((args) => args[2]);
    const addCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "add")
      .map((args) => args[args.indexOf("--name") + 1]);

    expect(updateCalls).toBe(2);
    expect(removeCalls).toEqual(["memory-root-main", "memory-alt-main", "memory-dir-main"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-alt-main", "memory-dir-main"]);
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("suspected null-byte collection metadata"),
    );

    await manager.close();
  });

  it("rebuilds managed collections once when qmd update hits duplicate document constraint", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(
            child,
            "stderr",
            "SQLiteError: UNIQUE constraint failed: documents.collection, documents.path",
            1,
          );
          return child;
        }
        queueMicrotask(() => {
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove")
      .map((args) => args[2]);
    const addCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "add")
      .map((args) => args[args.indexOf("--name") + 1]);

    expect(updateCalls).toBe(2);
    expect(removeCalls).toEqual(["memory-root-main", "memory-alt-main", "memory-dir-main"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-alt-main", "memory-dir-main"]);
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("duplicate document constraint"),
    );

    await manager.close();
  });

  it("does not rebuild collections for unrelated unique constraint failures", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "SQLiteError: UNIQUE constraint failed: documents.docid", 1);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).rejects.toThrow(
      "SQLiteError: UNIQUE constraint failed: documents.docid",
    );

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove");
    expect(removeCalls).toHaveLength(0);

    await manager.close();
  });

  it("does not rebuild collections for generic qmd update failures", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stderr",
          "ENOTDIR: not a directory, open '/tmp/workspace/MEMORY.md'",
          1,
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).rejects.toThrow(
      "ENOTDIR: not a directory, open '/tmp/workspace/MEMORY.md'",
    );

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove");
    expect(removeCalls).toHaveLength(0);

    await manager.close();
  });

  it("uses configured qmd search mode command", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]).toEqual([
      "search",
      "test",
      "--json",
      "-n",
      String(resolved.qmd?.limits.maxResults),
      "-c",
      "workspace-main",
    ]);
    expect(
      spawnMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "query"),
    ).toBe(false);
    expect(maxResults).toBeGreaterThan(0);
    await manager.close();
  });

  it("repairs missing managed collections and retries search once", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: true,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const expectedDocId = "abc123";
    let missingCollectionSeen = false;
    let addCallsAfterMissing = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        if (missingCollectionSeen) {
          addCallsAfterMissing += 1;
        }
        return createMockChild();
      }
      if (args[0] === "search") {
        const collectionFlagIndex = args.indexOf("-c");
        const collection = collectionFlagIndex >= 0 ? args[collectionFlagIndex + 1] : "";
        if (collection === "memory-root-main" && !missingCollectionSeen) {
          missingCollectionSeen = true;
          const child = createMockChild({ autoClose: false });
          emitAndClose(child, "stderr", "Collection not found: memory-root-main", 1);
          return child;
        }
        if (collection === "memory-root-main") {
          const child = createMockChild({ autoClose: false });
          emitAndClose(
            child,
            "stdout",
            JSON.stringify([{ docid: expectedDocId, score: 1, snippet: "@@ -1,1\nremember this" }]),
          );
          return child;
        }
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(expectedDocId)) {
            return [{ collection: "memory-root-main", path: "MEMORY.md" }];
          }
          return [];
        },
      }),
      close: () => {},
    };

    await expect(
      manager.search("remember", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "@@ -1,1\nremember this",
        source: "memory",
      },
    ]);
    expect(addCallsAfterMissing).toBeGreaterThan(0);
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("repairing collections and retrying once"),
    );

    await manager.close();
  });

  it("resolves bare qmd command to a Windows-compatible spawn invocation", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const previousPath = process.env.PATH;
    try {
      const nodeModulesDir = path.join(tmpRoot, "node_modules");
      const shimDir = path.join(nodeModulesDir, ".bin");
      const packageDir = path.join(nodeModulesDir, "qmd");
      const scriptPath = path.join(packageDir, "dist", "cli.js");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.mkdir(shimDir, { recursive: true });
      await fs.writeFile(path.join(shimDir, "qmd.cmd"), "@echo off\r\n", "utf8");
      await fs.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "qmd", version: "0.0.0", bin: { qmd: "dist/cli.js" } }),
        "utf8",
      );
      await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");
      process.env.PATH = `${shimDir};${previousPath ?? ""}`;

      const { manager } = await createManager({ mode: "status" });
      await manager.sync({ reason: "manual" });

      const qmdCalls = spawnMock.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[] | undefined;
        return (
          Array.isArray(args) &&
          args.some((token) => token === "update" || token === "search" || token === "query")
        );
      });
      expect(qmdCalls.length).toBeGreaterThan(0);
      for (const call of qmdCalls) {
        const command = String(call[0]);
        const options = call[2] as { shell?: boolean } | undefined;
        expect(command).not.toMatch(/(^|[\\/])qmd\.cmd$/i);
        expect(options?.shell).not.toBe(true);
      }

      await manager.close();
    } finally {
      platformSpy.mockRestore();
      process.env.PATH = previousPath;
    }
  });

  it("keeps mixed Han-script BM25 queries intact before qmd search", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("記憶系統升級 QMD", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]).toEqual([
      "search",
      "記憶系統升級 QMD",
      "--json",
      "-n",
      String(maxResults),
      "-c",
      "workspace-main",
    ]);
    await manager.close();
  });

  it("falls back to the original query when Han normalization yields no BM25 tokens", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    await expect(manager.search("記", { sessionKey: "agent:main:slack:dm:u123" })).resolves.toEqual(
      [],
    );

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]?.[1]).toBe("記");
    await manager.close();
  });

  it("keeps spaced Han queries intact before qmd search", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const query = "自然 高级感 结论先行 搜索偏好";
    await expect(
      manager.search(query, { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]?.[1]).toBe(query);
    await manager.close();
  });

  it("keeps original Han queries in qmd query mode", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    await expect(
      manager.search("記憶系統升級 QMD", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const queryCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "query",
    );
    expect(queryCall?.[1]?.[1]).toBe("記憶系統升級 QMD");
    await manager.close();
  });

  it("retries search with qmd query when configured mode rejects flags", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "unknown flag: --json", 2);
        return child;
      }
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchAndQueryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1])
      .filter(
        (args): args is string[] => Array.isArray(args) && ["search", "query"].includes(args[0]),
      );
    expect(searchAndQueryCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
    ]);
    await manager.close();
  });

  it("queues a forced sync behind an in-flight update", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            updateTimeoutMs: 1_000,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const firstUpdateSpawned = createDeferred<void>();
    let updateCalls = 0;
    let releaseFirstUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          const first = createMockChild({ autoClose: false });
          releaseFirstUpdate = () => first.closeWith(0);
          firstUpdateSpawned.resolve();
          return first;
        }
        return createMockChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inFlight = manager.sync({ reason: "interval" });
    const forced = manager.sync({ reason: "manual", force: true });

    await firstUpdateSpawned.promise;
    expect(updateCalls).toBe(1);
    if (!releaseFirstUpdate) {
      throw new Error("first update release missing");
    }
    (releaseFirstUpdate as () => void)();

    await Promise.all([inFlight, forced]);
    expect(updateCalls).toBe(2);
    await manager.close();
  });

  it("honors multiple forced sync requests while forced queue is active", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            updateTimeoutMs: 1_000,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const firstUpdateSpawned = createDeferred<void>();
    const secondUpdateSpawned = createDeferred<void>();
    let updateCalls = 0;
    let releaseFirstUpdate: (() => void) | null = null;
    let releaseSecondUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          const first = createMockChild({ autoClose: false });
          releaseFirstUpdate = () => first.closeWith(0);
          firstUpdateSpawned.resolve();
          return first;
        }
        if (updateCalls === 2) {
          const second = createMockChild({ autoClose: false });
          releaseSecondUpdate = () => second.closeWith(0);
          secondUpdateSpawned.resolve();
          return second;
        }
        return createMockChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inFlight = manager.sync({ reason: "interval" });
    const forcedOne = manager.sync({ reason: "manual", force: true });

    await firstUpdateSpawned.promise;
    expect(updateCalls).toBe(1);
    if (!releaseFirstUpdate) {
      throw new Error("first update release missing");
    }
    (releaseFirstUpdate as () => void)();

    await secondUpdateSpawned.promise;
    const forcedTwo = manager.sync({ reason: "manual-again", force: true });

    if (!releaseSecondUpdate) {
      throw new Error("second update release missing");
    }
    (releaseSecondUpdate as () => void)();

    await Promise.all([inFlight, forcedOne, forcedTwo]);
    expect(updateCalls).toBe(3);
    await manager.close();
  });

  it("scopes qmd queries to managed collections", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();

    await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }
    const searchCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "search");
    expect(searchCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["search", "test", "--json", "-n", String(maxResults), "-c", "notes-main"],
    ]);
    await manager.close();
  });

  it("uses explicit external custom collection names verbatim at query time", async () => {
    const sharedMirrorDir = path.join(tmpRoot, "shared-notion-mirror");
    await fs.mkdir(sharedMirrorDir);
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: sharedMirrorDir, pattern: "**/*.md", name: "notion-mirror" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();

    await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }
    const searchCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "search");
    expect(searchCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "notion-mirror"],
    ]);
    await manager.close();
  });

  it("runs qmd query per collection when query mode has multiple collection filters", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const queryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "query");
    expect(queryCalls).toEqual([
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "notes-main"],
    ]);
    await manager.close();
  });

  it("uses per-collection query fallback when search mode rejects flags", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stderr", "unknown flag: --json", 2);
        return child;
      }
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const searchAndQueryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "search" || args[0] === "query");
    expect(searchAndQueryCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "notes-main"],
    ]);
    await manager.close();
  });

  it("runs qmd searches via mcporter and warns when startDaemon=false", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();

    logWarnMock.mockClear();
    await expect(
      manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([]);

    const mcporterCalls = spawnMock.mock.calls.filter((call: unknown[]) =>
      isMcporterCommand(call[0]),
    );
    expect(mcporterCalls.length).toBeGreaterThan(0);
    expect(mcporterCalls.some((call: unknown[]) => (call[1] as string[])[0] === "daemon")).toBe(
      false,
    );
    expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining("cold-start"));

    await manager.close();
  });

  it("uses QMD 1.1+ query tool with searches array via mcporter", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        // Verify it calls qmd.query (v2) not qmd.deep_search (v1)
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(args[args.indexOf("--args") + 1]);
        // Verify QMD 1.1+ searches array format
        expect(callArgs).toHaveProperty("searches");
        expect(Array.isArray(callArgs.searches)).toBe(true);
        expect(callArgs.searches).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "lex" }),
            expect.objectContaining({ type: "vec" }),
            expect.objectContaining({ type: "hyde" }),
          ]),
        );
        expect(callArgs).toHaveProperty("collections", ["workspace-main"]);
        // Should NOT have flat query/minScore (v1 format)
        expect(callArgs).not.toHaveProperty("query");
        expect(callArgs).not.toHaveProperty("minScore");
        expect(callArgs).not.toHaveProperty("collection");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();
  });

  it("falls back to QMD <1.1 tool names when query tool is not found", async () => {
    // qmdMcpToolVersion is an instance field — each createManager() starts fresh.

    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    let callCount = 0;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        callCount++;
        const toolSelector = args[1];
        if (toolSelector === "qmd.query") {
          // Simulate QMD <1.1 — "query" tool does not exist
          // The error message appears in stdout (mcporter wraps MCP errors in JSON output)
          queueMicrotask(() => {
            child.stderr.emit("data", "MCP error -32602: Tool query not found");
            child.closeWith(1);
          });
          return child;
        }
        if (toolSelector === "qmd.deep_search") {
          // v1 tool exists — verify v1 args format
          const callArgs = JSON.parse(args[args.indexOf("--args") + 1]);
          expect(callArgs).toHaveProperty("query");
          expect(callArgs).not.toHaveProperty("searches");
          // Return empty results (avoids needing a SQLite fixture)
          emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
          return child;
        }
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    // The first search should try v2, fail, then retry with v1
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    // Should have logged the v1 fallback warning
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("falling back to v1 tool names"),
    );

    // One v2 attempt (fails) + one v1 retry (succeeds) per collection
    expect(callCount).toBe(2);

    await manager.close();
  });

  it("uses an explicit mcporter search tool override with flat query args", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          searchTool: "hybrid_search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.hybrid_search");
        const callArgs = JSON.parse(args[args.indexOf("--args") + 1]);
        expect(callArgs).toMatchObject({
          query: "hello",
          limit: 6,
          minScore: 0,
          collection: "workspace-main",
        });
        expect(callArgs).not.toHaveProperty("searches");
        expect(callArgs).not.toHaveProperty("collections");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();
  });

  it("prefers mcporter start and end lines over snippet header offsets", async () => {
    const expectedDocId = "line-123";
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        emitAndClose(
          child,
          "stdout",
          JSON.stringify({
            results: [
              {
                docid: expectedDocId,
                score: 0.91,
                collection: "workspace-main",
                start_line: 8,
                end_line: 10,
                snippet: "@@ -20,3\nline one\nline two\nline three",
              },
            ],
          }),
        );
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(expectedDocId)) {
            return [{ collection: "workspace-main", path: "notes/welcome.md" }];
          }
          return [];
        },
      }),
      close: () => {},
    };

    await expect(
      manager.search("line one", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "notes/welcome.md",
        startLine: 8,
        endLine: 10,
        score: 0.91,
        snippet: "@@ -20,3\nline one\nline two\nline three",
        source: "memory",
      },
    ]);

    await manager.close();
  });

  it("uses snippet header width when mcporter only returns a start line", async () => {
    const expectedDocId = "line-456";
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        emitAndClose(
          child,
          "stdout",
          JSON.stringify({
            results: [
              {
                docid: expectedDocId,
                score: 0.73,
                collection: "workspace-main",
                start_line: 8,
                snippet: "@@ -20,3\nline one\nline two\nline three",
              },
            ],
          }),
        );
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(expectedDocId)) {
            return [{ collection: "workspace-main", path: "notes/welcome.md" }];
          }
          return [];
        },
      }),
      close: () => {},
    };

    await expect(
      manager.search("line one", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "notes/welcome.md",
        startLine: 8,
        endLine: 10,
        score: 0.73,
        snippet: "@@ -20,3\nline one\nline two\nline three",
        source: "memory",
      },
    ]);

    await manager.close();
  });

  it('uses unified v2 args when the explicit mcporter search tool override is "query"', async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          searchTool: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(args[args.indexOf("--args") + 1]);
        expect(callArgs).toHaveProperty("searches", [{ type: "lex", query: "hello" }]);
        expect(callArgs).toHaveProperty("collections", ["workspace-main"]);
        expect(callArgs).not.toHaveProperty("query");
        expect(callArgs).not.toHaveProperty("minScore");
        expect(callArgs).not.toHaveProperty("collection");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();
  });

  it('reuses the cached v1 tool across collections when the explicit mcporter override is "query"', async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          searchTool: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: path.join(workspaceDir, "notes-a"), pattern: "**/*.md", name: "workspace-a" },
            { path: path.join(workspaceDir, "notes-b"), pattern: "**/*.md", name: "workspace-b" },
          ],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    const selectors: string[] = [];
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        const selector = args[1] ?? "";
        selectors.push(selector);
        if (selector === "qmd.query") {
          queueMicrotask(() => {
            child.stderr.emit("data", "MCP error -32602: Tool query not found");
            child.closeWith(1);
          });
          return child;
        }
        const callArgs = JSON.parse(args[args.indexOf("--args") + 1]);
        expect(selector).toBe("qmd.search");
        expect(callArgs).toMatchObject({
          query: "hello",
          limit: 6,
          minScore: 0,
        });
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    expect(selectors).toEqual(["qmd.query", "qmd.search", "qmd.search"]);

    await manager.close();
  });

  it("uses an explicit mcporter search tool override across multiple collections", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          searchTool: "hybrid_search",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: path.join(workspaceDir, "notes-a"), pattern: "**/*.md", name: "workspace-a" },
            { path: path.join(workspaceDir, "notes-b"), pattern: "**/*.md", name: "workspace-b" },
          ],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    const selectors: string[] = [];
    const collections: string[] = [];
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        selectors.push(args[1] ?? "");
        const callArgs = JSON.parse(args[args.indexOf("--args") + 1]);
        collections.push(String(callArgs.collection ?? ""));
        expect(callArgs).toMatchObject({
          query: "hello",
          limit: 6,
          minScore: 0,
        });
        expect(callArgs).not.toHaveProperty("searches");
        expect(callArgs).not.toHaveProperty("collections");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    expect(selectors).toEqual(["qmd.hybrid_search", "qmd.hybrid_search"]);
    expect(collections).toEqual(["workspace-a-main", "workspace-b-main"]);

    await manager.close();
  });

  it("does not pin v1 fallback when only the serialized query text contains tool-not-found words", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    const selectors: string[] = [];
    let firstQueryCall = true;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        selectors.push(args[1] ?? "");
        if (args[1] === "qmd.query" && firstQueryCall) {
          firstQueryCall = false;
          queueMicrotask(() => {
            child.stderr.emit("data", "backend unavailable");
            child.closeWith(1);
          });
          return child;
        }
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();

    await expect(
      manager.search("abc: Tool query not found", {
        sessionKey: "agent:main:slack:dm:u123",
      }),
    ).resolves.toEqual([]);

    await manager.search("hello again", { sessionKey: "agent:main:slack:dm:u123" });

    expect(selectors.length).toBeGreaterThanOrEqual(2);
    expect(selectors.every((selector) => selector === "qmd.query")).toBe(true);
    expect(logWarnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("falling back to v1 tool names"),
    );

    await manager.close();
  });

  it("does not pin v1 fallback when a timed out query contains tool-not-found words", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    const selectors: string[] = [];
    let firstQueryCall = true;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        selectors.push(args[1] ?? "");
        if (args[1] === "qmd.query" && firstQueryCall) {
          firstQueryCall = false;
          return child;
        }
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    const managerWithPrivate = manager as object as {
      runMcporter: (typeof manager)["runMcporter"];
    };
    const originalRunMcporter = managerWithPrivate.runMcporter.bind(managerWithPrivate);
    let injectTimeoutOnce = true;
    const runMcporterSpy = vi
      .spyOn(managerWithPrivate, "runMcporter")
      .mockImplementation(async (...args) => {
        if (injectTimeoutOnce) {
          injectTimeoutOnce = false;
          firstQueryCall = false;
          throw new Error(
            'mcporter call qmd.query --args {"query":"abc: Tool query not found"} timed out after 5000ms',
          );
        }
        return await originalRunMcporter(...args);
      });

    await expect(
      manager.search("abc: Tool query not found", {
        sessionKey: "agent:main:slack:dm:u123",
      }),
    ).rejects.toThrow("timed out after 5000ms");

    await manager.search("hello again", { sessionKey: "agent:main:slack:dm:u123" });

    expect(runMcporterSpy).toHaveBeenCalled();
    expect(selectors.length).toBeGreaterThanOrEqual(1);
    expect(selectors.every((selector) => selector === "qmd.query")).toBe(true);
    expect(logWarnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("falling back to v1 tool names"),
    );

    runMcporterSpy.mockRestore();
    await manager.close();
  });

  it("resolves mcporter to a direct Windows entrypoint without enabling shell mode", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const previousPath = process.env.PATH;
    try {
      const nodeModulesDir = path.join(tmpRoot, "node_modules");
      const shimDir = path.join(nodeModulesDir, ".bin");
      const packageDir = path.join(nodeModulesDir, "mcporter");
      const scriptPath = path.join(packageDir, "dist", "cli.js");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.mkdir(shimDir, { recursive: true });
      await fs.writeFile(path.join(shimDir, "mcporter.cmd"), "@echo off\r\n", "utf8");
      await fs.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "mcporter", version: "0.0.0", bin: { mcporter: "dist/cli.js" } }),
        "utf8",
      );
      await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");
      process.env.PATH = `${shimDir};${previousPath ?? ""}`;

      cfg = {
        ...cfg,
        memory: {
          backend: "qmd",
          qmd: {
            includeDefaultMemory: false,
            update: { interval: "0s", debounceMs: 60_000, onBoot: false },
            paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
            mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
          },
        },
      } as OpenClawConfig;

      spawnMock.mockImplementation((_cmd: string, args: string[]) => {
        const child = createMockChild({ autoClose: false });
        if (args[0] === "call") {
          emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
          return child;
        }
        emitAndClose(child, "stdout", "[]");
        return child;
      });

      const { manager } = await createManager();
      await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

      const mcporterCall = spawnMock.mock.calls.find((call: unknown[]) =>
        (call[1] as string[] | undefined)?.includes("call"),
      );
      expect(mcporterCall).toBeDefined();
      const callCommand = mcporterCall?.[0];
      expect(typeof callCommand).toBe("string");
      const options = mcporterCall?.[2] as { shell?: boolean } | undefined;
      expect(callCommand).not.toBe("mcporter.cmd");
      expect(options?.shell).not.toBe(true);

      await manager.close();
    } finally {
      platformSpy.mockRestore();
      process.env.PATH = previousPath;
    }
  });

  it("fails closed on Windows EINVAL cmd-shim failures instead of retrying through the shell", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const previousPath = process.env.PATH;
    try {
      const shimDir = await fs.mkdtemp(path.join(tmpRoot, "mcporter-shim-"));
      await fs.writeFile(path.join(shimDir, "mcporter.cmd"), "@echo off\n");
      process.env.PATH = `${shimDir};${previousPath ?? ""}`;

      cfg = {
        ...cfg,
        memory: {
          backend: "qmd",
          qmd: {
            includeDefaultMemory: false,
            update: { interval: "0s", debounceMs: 60_000, onBoot: false },
            paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
            mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
          },
        },
      } as OpenClawConfig;

      let firstCallCommand: string | null = null;
      spawnMock.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "call" && firstCallCommand === null) {
          firstCallCommand = cmd;
        }
        if (args[0] === "call" && typeof cmd === "string" && cmd.toLowerCase().endsWith(".cmd")) {
          const child = createMockChild({ autoClose: false });
          queueMicrotask(() => {
            const err = Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
            child.emit("error", err);
          });
          return child;
        }
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      });

      const { manager } = await createManager();
      await expect(
        manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" }),
      ).rejects.toThrow(/without shell execution|EINVAL/);
      const attemptedCmdShim = (firstCallCommand ?? "").toLowerCase().endsWith(".cmd");
      if (attemptedCmdShim) {
        expect(
          spawnMock.mock.calls.some(
            (call: unknown[]) =>
              call[0] === "mcporter" &&
              (call[2] as { shell?: boolean } | undefined)?.shell === true,
          ),
        ).toBe(false);
      }
      await manager.close();
    } finally {
      platformSpy.mockRestore();
      process.env.PATH = previousPath;
    }
  });

  it("passes manager-scoped XDG env to mcporter commands", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    const mcporterCall = spawnMock.mock.calls.find(
      (call: unknown[]) => isMcporterCommand(call[0]) && (call[1] as string[])[0] === "call",
    );
    expect(mcporterCall).toBeDefined();
    const spawnOpts = mcporterCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const normalizePath = (value?: string) => value?.replace(/\\/g, "/");
    expect(normalizePath(spawnOpts?.env?.XDG_CONFIG_HOME)).toContain("/agents/main/qmd/xdg-config");
    expect(normalizePath(spawnOpts?.env?.QMD_CONFIG_DIR)).toContain(
      "/agents/main/qmd/xdg-config/qmd",
    );
    expect(normalizePath(spawnOpts?.env?.XDG_CACHE_HOME)).toContain("/agents/main/qmd/xdg-cache");

    await manager.close();
  });

  it("retries mcporter daemon start after a failure", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: true },
        },
      },
    } as OpenClawConfig;

    let daemonAttempts = 0;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "daemon") {
        daemonAttempts += 1;
        if (daemonAttempts === 1) {
          emitAndClose(child, "stderr", "failed", 1);
        } else {
          emitAndClose(child, "stdout", "");
        }
        return child;
      }
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();

    await manager.search("one", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.search("two", { sessionKey: "agent:main:slack:dm:u123" });

    expect(daemonAttempts).toBe(2);

    await manager.close();
  });

  it("starts the mcporter daemon only once when enabled", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          mcporter: { enabled: true, serverName: "qmd", startDaemon: true },
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "daemon") {
        emitAndClose(child, "stdout", "");
        return child;
      }
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();

    await manager.search("one", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.search("two", { sessionKey: "agent:main:slack:dm:u123" });

    const daemonStarts = spawnMock.mock.calls.filter(
      (call: unknown[]) => isMcporterCommand(call[0]) && (call[1] as string[])[0] === "daemon",
    );
    expect(daemonStarts).toHaveLength(1);

    await manager.close();
  });

  it("fails closed when no managed collections are configured", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager();

    const results = await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toEqual([]);
    expect(
      spawnMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "query"),
    ).toBe(false);
    await manager.close();
  });

  it("diversifies mixed session and memory search results so memory hits are retained", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          sessions: { enabled: true },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([{ docid: "m1", score: 0.6, snippet: "@@ -1,1\nmemory fact" }]),
        );
        return child;
      }
      if (args[0] === "search" && args.includes("sessions-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { docid: "s1", score: 0.99, snippet: "@@ -1,1\nsession top 1" },
            { docid: "s2", score: 0.95, snippet: "@@ -1,1\nsession top 2" },
            { docid: "s3", score: 0.91, snippet: "@@ -1,1\nsession top 3" },
            { docid: "s4", score: 0.88, snippet: "@@ -1,1\nsession top 4" },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (_query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          switch (arg) {
            case "m1":
              return [{ collection: "workspace-main", path: "memory/facts.md" }];
            case "s1":
            case "s2":
            case "s3":
            case "s4":
              return [
                {
                  collection: "sessions-main",
                  path: `${arg}.md`,
                },
              ];
            default:
              return [];
          }
        },
      }),
      close: () => {},
    };

    const results = await manager.search("fact", {
      maxResults: 4,
      sessionKey: "agent:main:slack:dm:u123",
    });

    expect(results).toHaveLength(4);
    expect(results.some((entry) => entry.source === "memory")).toBe(true);
    expect(results.some((entry) => entry.source === "sessions")).toBe(true);
    await manager.close();
  });

  it("logs and continues when qmd embed times out", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            embedTimeoutMs: 20,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "embed") {
        return createMockChild({ autoClose: false });
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfig({ cfg, agentId });
    const createPromise = QmdMemoryManager.create({ cfg, agentId, resolved, mode: "status" });
    await vi.advanceTimersByTimeAsync(0);
    const manager = trackManager(await createPromise);
    expect(manager).toBeTruthy();
    if (!manager) {
      throw new Error("manager missing");
    }
    const syncPromise = manager.sync({ reason: "manual" });
    const resolvedSync = expect(syncPromise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    await resolvedSync;
    await manager.close();
  });

  it("runs periodic embed maintenance even when regular update scheduling is disabled", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            embedInterval: "5m",
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });

    const commandCallsBefore = spawnMock.mock.calls.filter((call: unknown[]) => {
      const args = call[1] as string[];
      return args[0] === "update" || args[0] === "embed";
    });
    expect(commandCallsBefore).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("runs periodic embed maintenance when embed cadence is faster than update cadence", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "20m",
            debounceMs: 0,
            onBoot: false,
            embedInterval: "5m",
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("does not schedule redundant embed maintenance when regular updates are already more frequent", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "5m",
            debounceMs: 0,
            onBoot: false,
            embedInterval: "20m",
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });

    await vi.advanceTimersByTimeAsync(6 * 60_000);

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("arms periodic embed maintenance in search mode", async () => {
    vi.useFakeTimers();
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            embedInterval: "5m",
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("delays the first periodic embed maintenance run by stable startup jitter", async () => {
    vi.useFakeTimers();
    embedStartupJitterSpy?.mockRestore();
    embedStartupJitterSpy = vi
      .spyOn(
        QmdMemoryManager.prototype as unknown as {
          resolveEmbedStartupJitterMs: () => number;
        },
        "resolveEmbedStartupJitterMs",
      )
      .mockReturnValue(60_000);
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "query",
          update: {
            interval: "0s",
            debounceMs: 0,
            onBoot: false,
            embedInterval: "5m",
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "full" });

    await vi.advanceTimersByTimeAsync(59_999);
    const beforeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(beforeCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("serializes qmd embeds within a process before taking the shared file lock", async () => {
    vi.useFakeTimers();
    const embedChildren: MockChild[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "embed") {
        const child = createMockChild({ autoClose: false });
        embedChildren.push(child);
        return child;
      }
      return createMockChild();
    });

    const first = await createManager({ mode: "status" });
    const second = await createManager({ mode: "status" });
    const firstSync = first.manager.sync({ reason: "manual", force: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(embedChildren).toHaveLength(1);
    expect(withFileLockMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        retries: expect.objectContaining({
          retries: expect.any(Number),
          maxTimeout: 10_000,
        }),
        stale: expect.any(Number),
      }),
      expect.any(Function),
    );
    const lockOptions = withFileLockMock.mock.calls[0]?.[1] as {
      retries: { retries: number };
      stale: number;
    };
    expect(lockOptions.retries.retries).toBeGreaterThanOrEqual(90);
    expect(lockOptions.stale).toBeGreaterThanOrEqual(15 * 60 * 1000);

    const secondSync = second.manager.sync({ reason: "manual", force: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(embedChildren).toHaveLength(1);

    embedChildren[0]?.closeWith(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(embedChildren).toHaveLength(2);

    embedChildren[1]?.closeWith(0);
    await expect(firstSync).resolves.toBeUndefined();
    await expect(secondSync).resolves.toBeUndefined();
    await first.manager.close();
    await second.manager.close();
  });

  it("runs qmd embed in search mode for forced sync", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: { interval: "0s", debounceMs: 0, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager({ mode: "status" });
    await manager.sync({ reason: "manual", force: true });

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);
    await manager.close();
  });

  it("retries boot update when qmd reports a retryable lock error", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          searchMode: "search",
          update: {
            interval: "0s",
            debounceMs: 60_000,
            onBoot: true,
            waitForBootSync: true,
          },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(child, "stderr", "SQLITE_BUSY: database is locked", 2);
        } else {
          emitAndClose(child, "stdout", "", 0);
        }
        return child;
      }
      return createMockChild();
    });

    const nativeSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (typeof timeout === "number" && timeout >= 500) {
        return nativeSetTimeout(handler, 1, ...args);
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof globalThis.setTimeout);

    const { manager } = await createManager({ mode: "full" });

    try {
      expect(updateCalls).toBe(2);
      await manager.close();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("succeeds on qmd update even when stdout exceeds the output cap", async () => {
    // Regression test for #24966: large indexes produce >200K chars of stdout
    // during `qmd update`, which used to fail with "produced too much output".
    const largeOutput = "x".repeat(300_000);
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", largeOutput);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    // sync triggers runQmdUpdateOnce -> runQmd(["update"], { discardOutput: true })
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();
    await manager.close();
  });

  it("scopes by channel for agent-prefixed session keys", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          scope: {
            default: "deny",
            rules: [{ action: "allow", match: { channel: "slack" } }],
          },
        },
      },
    } as OpenClawConfig;
    const { manager } = await createManager();

    const isAllowed = (key?: string) =>
      (manager as unknown as { isScopeAllowed: (key?: string) => boolean }).isScopeAllowed(key);
    expect(isAllowed("agent:main:slack:channel:c123")).toBe(true);
    expect(isAllowed("agent:main:slack:direct:u123")).toBe(true);
    expect(isAllowed("agent:main:slack:dm:u123")).toBe(true);
    expect(isAllowed("agent:main:discord:direct:u123")).toBe(false);
    expect(isAllowed("agent:main:discord:channel:c123")).toBe(false);

    await manager.close();
  });

  it("logs when qmd scope denies search", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
          scope: {
            default: "deny",
            rules: [{ action: "allow", match: { chatType: "direct" } }],
          },
        },
      },
    } as OpenClawConfig;
    const { manager } = await createManager();

    logWarnMock.mockClear();
    const beforeCalls = spawnMock.mock.calls.length;
    await expect(
      manager.search("blocked", { sessionKey: "agent:main:discord:channel:c123" }),
    ).resolves.toEqual([]);

    expect(spawnMock.mock.calls.length).toBe(beforeCalls);
    expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining("qmd search denied by scope"));
    expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining("chatType=channel"));

    await manager.close();
  });

  it("blocks non-markdown or symlink reads for qmd paths", async () => {
    const { manager } = await createManager();

    const textPath = path.join(workspaceDir, "secret.txt");
    await fs.writeFile(textPath, "nope", "utf-8");
    await expect(manager.readFile({ relPath: "qmd/workspace-main/secret.txt" })).rejects.toThrow(
      "path required",
    );

    const target = path.join(workspaceDir, "target.md");
    await fs.writeFile(target, "ok", "utf-8");
    const link = path.join(workspaceDir, "link.md");
    await fs.symlink(target, link);
    await expect(manager.readFile({ relPath: "qmd/workspace-main/link.md" })).rejects.toThrow(
      "path required",
    );

    await manager.close();
  });

  it("reads only requested line ranges without loading the whole file", async () => {
    const readFileSpy = vi.spyOn(fs, "readFile");
    const text = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join("\n");
    await fs.writeFile(path.join(workspaceDir, "window.md"), text, "utf-8");

    const { manager } = await createManager();

    const result = await manager.readFile({ relPath: "window.md", from: 10, lines: 3 });
    expect(result.text).toBe("line-10\nline-11\nline-12");
    expect(readFileSpy).not.toHaveBeenCalled();

    await manager.close();
    readFileSpy.mockRestore();
  });

  it("returns empty text when qmd files are missing before or during read", async () => {
    const relPath = "qmd-window.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.writeFile(absPath, "one\ntwo\nthree", "utf-8");

    const cases = [
      {
        name: "missing before read",
        request: { relPath: "ghost.md" },
        expectedPath: "ghost.md",
      },
      {
        name: "disappears before partial read",
        request: { relPath, from: 2, lines: 1 },
        expectedPath: relPath,
        installOpenSpy: () => {
          const realOpen = fs.open;
          let injected = false;
          const openSpy = vi
            .spyOn(fs, "open")
            .mockImplementation(async (...args: Parameters<typeof realOpen>) => {
              const [target, options] = args;
              if (!injected && typeof target === "string" && path.resolve(target) === absPath) {
                injected = true;
                const err = new Error("gone") as NodeJS.ErrnoException;
                err.code = "ENOENT";
                throw err;
              }
              return realOpen(target, options);
            });
          return () => openSpy.mockRestore();
        },
      },
    ] as const;

    for (const testCase of cases) {
      const { manager } = await createManager();
      const restoreOpen = "installOpenSpy" in testCase ? testCase.installOpenSpy() : undefined;
      try {
        const result = await manager.readFile(testCase.request);
        expect(result, testCase.name).toEqual({ text: "", path: testCase.expectedPath });
      } finally {
        restoreOpen?.();
        await manager.close();
      }
    }
  });

  it("reuses exported session markdown files when inputs are unchanged", async () => {
    const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "session-1.jsonl");
    const exportFile = path.join(stateDir, "agents", agentId, "qmd", "sessions", "session-1.md");
    await fs.writeFile(
      sessionFile,
      '{"type":"message","message":{"role":"user","content":"hello"}}\n',
      "utf-8",
    );

    const currentMemory = cfg.memory;
    cfg = {
      ...cfg,
      memory: {
        ...currentMemory,
        qmd: {
          ...currentMemory?.qmd,
          sessions: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    const { manager } = await createManager();

    try {
      await manager.sync({ reason: "manual" });
      const firstExport = await fs.readFile(exportFile, "utf-8");
      expect(firstExport).toContain("hello");

      await manager.sync({ reason: "manual" });
      const secondExport = await fs.readFile(exportFile, "utf-8");
      expect(secondExport).toBe(firstExport);
    } finally {
      await manager.close();
    }
  });

  it("fails closed when sqlite index is busy during doc lookup or search", async () => {
    const cases = [
      {
        name: "resolveDocLocation",
        run: async (manager: QmdMemoryManager) => {
          const inner = manager as unknown as {
            db: {
              prepare: () => {
                all: () => never;
                get: () => never;
              };
              close: () => void;
            } | null;
            resolveDocLocation: (docid?: string) => Promise<unknown>;
          };
          const busyStmt: { all: () => never; get: () => never } = {
            all: () => {
              throw new Error("SQLITE_BUSY: database is locked");
            },
            get: () => {
              throw new Error("SQLITE_BUSY: database is locked");
            },
          };
          inner.db = {
            prepare: () => busyStmt,
            close: () => {},
          };
          await expect(inner.resolveDocLocation("abc123")).rejects.toThrow(
            "qmd index busy while reading results",
          );
        },
      },
      {
        name: "search",
        run: async (manager: QmdMemoryManager) => {
          spawnMock.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "search") {
              const child = createMockChild({ autoClose: false });
              emitAndClose(
                child,
                "stdout",
                JSON.stringify([{ docid: "abc123", score: 1, snippet: "@@ -1,1\nremember this" }]),
              );
              return child;
            }
            return createMockChild();
          });
          const inner = manager as unknown as {
            db: { prepare: () => { all: () => never }; close: () => void } | null;
          };
          inner.db = {
            prepare: () => ({
              all: () => {
                throw new Error("SQLITE_BUSY: database is locked");
              },
            }),
            close: () => {},
          };
          await expect(
            manager.search("busy lookup", { sessionKey: "agent:main:slack:dm:u123" }),
          ).rejects.toThrow("qmd index busy while reading results");
        },
      },
    ] as const;

    for (const testCase of cases) {
      spawnMock.mockClear();
      spawnMock.mockImplementation(() => createMockChild());
      const { manager } = await createManager();
      try {
        await testCase.run(manager);
      } catch (error) {
        throw new Error(
          `${testCase.name}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      } finally {
        await manager.close();
      }
    }
  });

  it("prefers exact docid match before prefix fallback for qmd document lookups", async () => {
    const prepareCalls: string[] = [];
    const exactDocid = "abc123";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { docid: exactDocid, score: 1, snippet: "@@ -5,2\nremember this\nnext line" },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (query: string) => {
        prepareCalls.push(query);
        return {
          all: (arg: unknown) => {
            if (query.includes("hash = ?")) {
              return [];
            }
            if (query.includes("hash LIKE ?")) {
              expect(arg).toBe(`${exactDocid}%`);
              return [{ collection: "workspace-main", path: "notes/welcome.md" }];
            }
            throw new Error(`unexpected sqlite query: ${query}`);
          },
        };
      },
      close: () => {},
    };

    const results = await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toEqual([
      {
        path: "notes/welcome.md",
        startLine: 5,
        endLine: 6,
        score: 1,
        snippet: "@@ -5,2\nremember this\nnext line",
        source: "memory",
      },
    ]);

    expect(prepareCalls).toHaveLength(2);
    expect(prepareCalls[0]).toContain("hash = ?");
    expect(prepareCalls[1]).toContain("hash LIKE ?");
    await manager.close();
  });

  it("prefers collection hint when resolving duplicate qmd document hashes", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    const duplicateDocid = "dup-123";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { docid: duplicateDocid, score: 0.9, snippet: "@@ -3,1\nworkspace hit" },
          ]),
        );
        return child;
      }
      if (args[0] === "search" && args.includes("notes-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(duplicateDocid)) {
            return [
              { collection: "stale-workspace", path: "notes/welcome.md" },
              { collection: "workspace-main", path: "notes/welcome.md" },
            ];
          }
          return [];
        },
      }),
      close: () => {},
    };

    const results = await manager.search("workspace", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toEqual([
      {
        path: "notes/welcome.md",
        startLine: 3,
        endLine: 3,
        score: 0.9,
        snippet: "@@ -3,1\nworkspace hit",
        source: "memory",
      },
    ]);
    await manager.close();
  });

  it("resolves search hits when qmd returns qmd:// file URIs without docid", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: "qmd://workspace-main/notes/welcome.md",
              score: 0.71,
              snippet: "@@ -4,1\ntoken unlock",
            },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const results = await manager.search("token unlock", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    expect(results).toEqual([
      {
        path: "notes/welcome.md",
        startLine: 4,
        endLine: 4,
        score: 0.71,
        snippet: "@@ -4,1\ntoken unlock",
        source: "memory",
      },
    ]);
    await manager.close();
  });

  it("returns collection-scoped qmd paths when session exports live under the workspace qmd directory", async () => {
    workspaceDir = path.join(stateDir, "agents", agentId);
    await fs.mkdir(workspaceDir, { recursive: true });
    cfg = {
      agents: {
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          sessions: { enabled: true },
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: "qmd://sessions-main/session-1.md",
              score: 0.84,
              snippet: "@@ -2,1\nsession canary",
            },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    const inner = manager as unknown as {
      collectionRoots: Map<string, { path: string }>;
      resolveReadPath: (relPath: string) => string;
    };
    const sessionRoot = inner.collectionRoots.get("sessions-main");
    expect(sessionRoot?.path).toBeTruthy();
    const exportedSessionPath = path.join(sessionRoot!.path, "session-1.md");

    const results = await manager.search("session canary", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    expect(results).toEqual([
      {
        path: "qmd/sessions-main/session-1.md",
        startLine: 2,
        endLine: 2,
        score: 0.84,
        snippet: "@@ -2,1\nsession canary",
        source: "sessions",
      },
    ]);

    expect(inner.resolveReadPath(results[0].path)).toBe(exportedSessionPath);
    const realLstat = fs.lstat;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      if (typeof target === "string" && path.resolve(target) === exportedSessionPath) {
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
        } as Awaited<ReturnType<typeof realLstat>>;
      }
      return await realLstat(target, options);
    });
    const realReadFile = fs.readFile;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      if (typeof target === "string" && path.resolve(target) === exportedSessionPath) {
        return "# Session session-1\n\nsession canary\n";
      }
      return await realReadFile(target, options as never);
    });

    try {
      const readResult = await manager.readFile({ relPath: results[0].path });
      expect(readResult).toEqual({
        path: "qmd/sessions-main/session-1.md",
        text: "# Session session-1\n\nsession canary\n",
      });
    } finally {
      lstatSpy.mockRestore();
      readSpy.mockRestore();
    }

    await manager.close();
  });

  it("preserves multi-collection qmd search hits when results only include file URIs", async () => {
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [
            { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
            { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
          ],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: "qmd://workspace-main/memory/facts.md",
              score: 0.8,
              snippet: "@@ -2,1\nworkspace fact",
            },
          ]),
        );
        return child;
      }
      if (args[0] === "search" && args.includes("notes-main")) {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: "qmd://notes-main/guide.md",
              score: 0.7,
              snippet: "@@ -1,1\nnotes guide",
            },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const results = await manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    expect(results).toEqual([
      {
        path: "memory/facts.md",
        startLine: 2,
        endLine: 2,
        score: 0.8,
        snippet: "@@ -2,1\nworkspace fact",
        source: "memory",
      },
      {
        path: "notes/guide.md",
        startLine: 1,
        endLine: 1,
        score: 0.7,
        snippet: "@@ -1,1\nnotes guide",
        source: "memory",
      },
    ]);
    await manager.close();
  });

  it("errors when qmd output exceeds command output safety cap", async () => {
    const noisyPayload = "x".repeat(240_000);
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", noisyPayload);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("noise", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/too much output/);
    await manager.close();
  });

  it("treats plain-text no-results markers from stdout/stderr as empty result sets", async () => {
    const cases = [
      { name: "stdout with punctuation", stream: "stdout", payload: "No results found." },
      { name: "stdout without punctuation", stream: "stdout", payload: "No results found\n\n" },
      { name: "stderr", stream: "stderr", payload: "No results found.\n" },
    ] as const;

    for (const testCase of cases) {
      spawnMock.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "search") {
          const child = createMockChild({ autoClose: false });
          emitAndClose(child, testCase.stream, testCase.payload);
          return child;
        }
        return createMockChild();
      });

      const { manager } = await createManager();
      await expect(
        manager.search("missing", { sessionKey: "agent:main:slack:dm:u123" }),
        testCase.name,
      ).resolves.toEqual([]);
      await manager.close();
    }
  });

  it("throws when stdout is empty without the no-results marker", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        queueMicrotask(() => {
          child.stdout.emit("data", "   \n");
          child.stderr.emit("data", "unexpected parser error");
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("missing", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/qmd query returned invalid JSON/);
    await manager.close();
  });

  it("sets busy_timeout on qmd sqlite connections", async () => {
    const { manager } = await createManager();
    const indexPath = (manager as unknown as { indexPath: string }).indexPath;
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const seedDb = new DatabaseSync(indexPath);
    seedDb.close();

    const db = (manager as unknown as { ensureDb: () => DatabaseSync }).ensureDb();
    const row = db.prepare("PRAGMA busy_timeout").get() as
      | { busy_timeout?: number; timeout?: number }
      | undefined;
    const busyTimeout = row?.busy_timeout ?? row?.timeout;
    expect(busyTimeout).toBe(1000);
    await manager.close();
  });

  it("reports vector availability as unavailable when qmd status shows zero vectors", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "Documents: 12\nVectors: 0\n");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(manager.probeVectorAvailability()).resolves.toBe(false);
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: false,
      error: "QMD index has 0 vectors; semantic search is unavailable until embeddings finish",
    });
    expect(manager.status().vector).toEqual({
      enabled: true,
      available: false,
      loadError: "QMD index has 0 vectors; semantic search is unavailable until embeddings finish",
    });
    await manager.close();
  });

  it("reports vector availability as ready when qmd status shows vectors", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", "Documents: 12\nVectors: 42\n");
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(manager.probeVectorAvailability()).resolves.toBe(true);
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: true,
      error: undefined,
    });
    expect(manager.status().vector).toEqual({
      enabled: true,
      available: true,
      loadError: undefined,
    });
    await manager.close();
  });

  describe("model cache symlink", () => {
    let defaultModelsDir: string;
    let customModelsDir: string;
    let savedXdgCacheHome: string | undefined;

    beforeEach(async () => {
      // Redirect XDG_CACHE_HOME so symlinkSharedModels finds our fake models
      // directory instead of the real ~/.cache.
      savedXdgCacheHome = process.env.XDG_CACHE_HOME;
      const fakeCacheHome = path.join(tmpRoot, "fake-cache");
      process.env.XDG_CACHE_HOME = fakeCacheHome;

      defaultModelsDir = path.join(fakeCacheHome, "qmd", "models");
      await fs.mkdir(defaultModelsDir, { recursive: true });
      await fs.writeFile(path.join(defaultModelsDir, "model.bin"), "fake-model");

      customModelsDir = path.join(stateDir, "agents", agentId, "qmd", "xdg-cache", "qmd", "models");
    });

    afterEach(() => {
      if (savedXdgCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = savedXdgCacheHome;
      }
    });

    it("handles first-run symlink, existing dir preservation, and missing default cache", async () => {
      const cases: Array<{
        name: string;
        setup?: () => Promise<void>;
        assert: () => Promise<void>;
      }> = [
        {
          name: "symlinks default cache on first run",
          assert: async () => {
            const stat = await fs.lstat(customModelsDir);
            expect(stat.isSymbolicLink()).toBe(true);
            const target = await fs.readlink(customModelsDir);
            expect(target).toBe(defaultModelsDir);
            const content = await fs.readFile(path.join(customModelsDir, "model.bin"), "utf-8");
            expect(content).toBe("fake-model");
          },
        },
        {
          name: "does not overwrite existing models directory",
          setup: async () => {
            await fs.mkdir(customModelsDir, { recursive: true });
            await fs.writeFile(path.join(customModelsDir, "custom-model.bin"), "custom");
          },
          assert: async () => {
            const stat = await fs.lstat(customModelsDir);
            expect(stat.isSymbolicLink()).toBe(false);
            expect(stat.isDirectory()).toBe(true);
            const content = await fs.readFile(
              path.join(customModelsDir, "custom-model.bin"),
              "utf-8",
            );
            expect(content).toBe("custom");
          },
        },
        {
          name: "skips symlink when default models are absent",
          setup: async () => {
            await fs.rm(defaultModelsDir, { recursive: true, force: true });
          },
          assert: async () => {
            await expect(fs.lstat(customModelsDir)).rejects.toThrow();
            expect(logWarnMock).not.toHaveBeenCalledWith(
              expect.stringContaining("failed to symlink qmd models directory"),
            );
          },
        },
      ];

      for (const testCase of cases) {
        await fs.rm(customModelsDir, { recursive: true, force: true });
        await fs.mkdir(defaultModelsDir, { recursive: true });
        await fs.writeFile(path.join(defaultModelsDir, "model.bin"), "fake-model");
        logWarnMock.mockClear();
        await testCase.setup?.();
        const { manager } = await createManager({ mode: "full" });
        expect(manager, testCase.name).toBeTruthy();
        try {
          await testCase.assert();
        } finally {
          await manager.close();
        }
      }
    });
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

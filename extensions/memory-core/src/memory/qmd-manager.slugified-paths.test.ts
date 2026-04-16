import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logWarnMock, logDebugMock, logInfoMock } = vi.hoisted(() => ({
  logWarnMock: vi.fn(),
  logDebugMock: vi.fn(),
  logInfoMock: vi.fn(),
}));

interface MockChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals) => void;
  closeWith: (code?: number | null) => void;
}

function createMockChild(params?: { autoClose?: boolean }): MockChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as unknown as MockChild;
  child.stdout = stdout;
  child.stderr = stderr;
  child.closeWith = (code = 0) => {
    child.emit("close", code);
  };
  child.kill = () => {};
  if (params?.autoClose !== false) {
    queueMicrotask(() => {
      child.emit("close", 0);
    });
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

import { spawn as mockedSpawn } from "node:child_process";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { QmdMemoryManager } from "./qmd-manager.js";

const spawnMock = mockedSpawn as unknown as Mock;

describe("QmdMemoryManager slugified path resolution", () => {
  let tmpRoot: string;
  let workspaceDir: string;
  let stateDir: string;
  let cfg: OpenClawConfig;
  const agentId = "main";
  const openManagers = new Set<QmdMemoryManager>();

  function trackManager<T extends QmdMemoryManager | null>(manager: T): T {
    if (manager) {
      openManagers.add(manager);
    }
    return manager;
  }

  async function createManager(params?: { cfg?: OpenClawConfig }) {
    const cfgToUse = params?.cfg ?? cfg;
    const resolved = resolveMemoryBackendConfig({ cfg: cfgToUse, agentId });
    const manager = trackManager(
      await QmdMemoryManager.create({
        cfg: cfgToUse,
        agentId,
        resolved,
        mode: "status",
      }),
    );
    if (!manager) {
      throw new Error("manager missing");
    }
    return { manager, resolved };
  }

  function installIndexedPathStub(params: {
    manager: QmdMemoryManager;
    collection: string;
    normalizedPath: string;
    actualPath?: string;
    exactPaths?: string[];
    allPaths?: string[];
  }) {
    const inner = params.manager as unknown as {
      db: {
        prepare: (query: string) => {
          get: (...args: unknown[]) => unknown;
          all: (...args: unknown[]) => unknown;
        };
        close: () => void;
      };
    };
    inner.db = {
      prepare: (query: string) => ({
        get: (...args: unknown[]) => {
          if (query.includes("collection = ? AND active = 1 AND path = ?")) {
            expect(args[0]).toBe(params.collection);
            const requestedPath = args[1];
            expect(typeof requestedPath).toBe("string");
            const exactCandidates = new Set([
              ...(params.exactPaths ?? []),
              ...(params.actualPath ? [params.actualPath] : []),
            ]);
            return typeof requestedPath === "string" && exactCandidates.has(requestedPath)
              ? { path: requestedPath }
              : undefined;
          }
          throw new Error(`unexpected sqlite query: ${query}`);
        },
        all: (...args: unknown[]) => {
          if (query.includes("collection = ? AND path = ? AND active = 1")) {
            expect(args).toEqual([params.collection, params.normalizedPath]);
            return (params.exactPaths ?? []).map((pathValue) => ({ path: pathValue }));
          }
          if (query.includes("collection = ? AND active = 1")) {
            expect(args).toEqual([params.collection]);
            return (params.allPaths ?? [params.actualPath]).map((pathValue) => ({
              path: pathValue,
            }));
          }
          throw new Error(`unexpected sqlite query: ${query}`);
        },
      }),
      close: () => {},
    };
  }

  beforeEach(async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createMockChild());
    logWarnMock.mockClear();
    logDebugMock.mockClear();
    logInfoMock.mockClear();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-slugified-"));
    workspaceDir = path.join(tmpRoot, "workspace");
    stateDir = path.join(tmpRoot, "state");
    await fs.mkdir(workspaceDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = stateDir;

    cfg = {
      agents: {
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
  });

  afterEach(async () => {
    await Promise.all(
      Array.from(openManagers, async (manager) => {
        await manager.close();
      }),
    );
    openManagers.clear();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    delete process.env.OPENCLAW_STATE_DIR;
  });

  it("maps slugified workspace qmd URIs back to the indexed filesystem path", async () => {
    const actualRelative = "extra-docs/Category/Sub Category/Topic Name/Topic Name.md";
    const actualFile = path.join(workspaceDir, actualRelative);
    await fs.mkdir(path.dirname(actualFile), { recursive: true });
    await fs.writeFile(actualFile, "line-1\nline-2\nline-3", "utf-8");

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: "qmd://workspace-main/extra-docs/category/sub-category/topic-name/topic-name.md",
              score: 0.73,
              snippet: "@@ -2,1\nline-2",
            },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    installIndexedPathStub({
      manager,
      collection: "workspace-main",
      normalizedPath: "extra-docs/category/sub-category/topic-name/topic-name.md",
      actualPath: actualRelative,
    });

    const results = await manager.search("line-2", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    expect(results).toEqual([
      {
        path: actualRelative,
        startLine: 2,
        endLine: 2,
        score: 0.73,
        snippet: "@@ -2,1\nline-2",
        source: "memory",
      },
    ]);

    await expect(manager.readFile({ relPath: results[0].path })).resolves.toEqual({
      path: actualRelative,
      text: "line-1\nline-2\nline-3",
      from: 1,
      lines: 3,
    });
  });

  it("maps slugified extra collection qmd URIs back to qmd/<collection>/ paths", async () => {
    const extraRoot = path.join(tmpRoot, "vault");
    await fs.mkdir(extraRoot, { recursive: true });
    cfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          includeDefaultMemory: false,
          update: { interval: "0s", debounceMs: 60_000, onBoot: false },
          paths: [{ path: extraRoot, pattern: "**/*.md", name: "vault" }],
        },
      },
    } as OpenClawConfig;

    const actualRelative = "Topics/Sub Category/Topic Name.md";
    const actualFile = path.join(extraRoot, actualRelative);
    await fs.mkdir(path.dirname(actualFile), { recursive: true });
    await fs.writeFile(actualFile, "vault memory", "utf-8");

    const { manager, resolved } = await createManager({ cfg });
    const collectionName =
      resolved.qmd?.collections.find((collection) => collection.path === extraRoot)?.name ??
      "vault";

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: `qmd://${collectionName}/topics/sub-category/topic-name.md`,
              score: 0.81,
              snippet: "@@ -1,1\nvault memory",
            },
          ]),
        );
        return child;
      }
      return createMockChild();
    });
    installIndexedPathStub({
      manager,
      collection: collectionName,
      normalizedPath: "topics/sub-category/topic-name.md",
      actualPath: actualRelative,
    });

    const results = await manager.search("vault memory", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    expect(results).toEqual([
      {
        path: `qmd/${collectionName}/${actualRelative}`,
        startLine: 1,
        endLine: 1,
        score: 0.81,
        snippet: "@@ -1,1\nvault memory",
        source: "memory",
      },
    ]);

    await expect(manager.readFile({ relPath: results[0].path })).resolves.toEqual({
      path: `qmd/${collectionName}/${actualRelative}`,
      text: "vault memory",
      from: 1,
      lines: 1,
    });
  });

  it("prefers an exact indexed path over normalized slug recovery", async () => {
    const exactRelative = "notes/topic-name.md";
    const slugCollisionRelative = "notes/Topic Name.md";
    const exactFile = path.join(workspaceDir, exactRelative);
    const collisionFile = path.join(workspaceDir, slugCollisionRelative);
    await fs.mkdir(path.dirname(exactFile), { recursive: true });
    await fs.writeFile(exactFile, "exact slugified path", "utf-8");
    await fs.writeFile(collisionFile, "mixed case path", "utf-8");

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            {
              file: "qmd://workspace-main/notes/topic-name.md",
              score: 0.79,
              snippet: "@@ -1,1\nexact slugified path",
            },
          ]),
        );
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    installIndexedPathStub({
      manager,
      collection: "workspace-main",
      normalizedPath: exactRelative,
      exactPaths: [exactRelative],
      allPaths: [exactRelative, slugCollisionRelative],
    });

    const results = await manager.search("exact slugified path", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    expect(results).toEqual([
      {
        path: exactRelative,
        startLine: 1,
        endLine: 1,
        score: 0.79,
        snippet: "@@ -1,1\nexact slugified path",
        source: "memory",
      },
    ]);

    await expect(manager.readFile({ relPath: results[0].path })).resolves.toEqual({
      path: exactRelative,
      text: "exact slugified path",
      from: 1,
      lines: 1,
    });
  });
});

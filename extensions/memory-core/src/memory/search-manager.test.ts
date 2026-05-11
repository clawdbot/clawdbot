import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { checkQmdBinaryAvailability as checkQmdBinaryAvailabilityFn } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import { beforeEach, describe, expect, it, vi } from "vitest";

type CheckQmdBinaryAvailability = typeof checkQmdBinaryAvailabilityFn;

function createManagerStatus(params: {
  backend: "qmd" | "builtin";
  provider: string;
  model: string;
  requestedProvider: string;
  withMemorySourceCounts?: boolean;
}) {
  const base = {
    backend: params.backend,
    provider: params.provider,
    model: params.model,
    requestedProvider: params.requestedProvider,
    files: 0,
    chunks: 0,
    dirty: false,
    workspaceDir: "/tmp",
    dbPath: "/tmp/index.sqlite",
  };
  if (!params.withMemorySourceCounts) {
    return base;
  }
  return {
    ...base,
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 0, chunks: 0 }],
  };
}

function nativePath(candidate: string): string {
  return path.resolve(candidate);
}

function createManagerMock(params: {
  backend: "qmd" | "builtin";
  provider: string;
  model: string;
  requestedProvider: string;
  searchResults?: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: "memory";
  }>;
  withMemorySourceCounts?: boolean;
}) {
  return {
    search: vi.fn(async () => params.searchResults ?? []),
    readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
    status: vi.fn(() =>
      createManagerStatus({
        backend: params.backend,
        provider: params.provider,
        model: params.model,
        requestedProvider: params.requestedProvider,
        withMemorySourceCounts: params.withMemorySourceCounts,
      }),
    ),
    sync: vi.fn(async () => {}),
    probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
    probeVectorAvailability: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
}

function createQmdManagerInstanceMock() {
  return createManagerMock({
    backend: "qmd",
    provider: "qmd",
    model: "qmd",
    requestedProvider: "qmd",
    withMemorySourceCounts: true,
  });
}

const mockPrimary = vi.hoisted(() => ({
  ...createQmdManagerInstanceMock(),
}));

const fallbackManager = vi.hoisted(() => ({
  ...createManagerMock({
    backend: "builtin",
    provider: "openai",
    model: "text-embedding-3-small",
    requestedProvider: "openai",
    searchResults: [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "fallback",
        source: "memory",
      },
    ],
  }),
}));

const fallbackSearch = fallbackManager.search;
const mockMemoryIndexGet = vi.hoisted(() => vi.fn(async () => fallbackManager));
const mockCloseAllMemoryIndexManagers = vi.hoisted(() => vi.fn(async () => {}));
const checkQmdBinaryAvailability = vi.hoisted(() =>
  vi.fn<CheckQmdBinaryAvailability>(async () => ({ available: true })),
);

vi.mock("./qmd-manager.js", () => ({
  QmdMemoryManager: {
    create: vi.fn(async () => mockPrimary),
  },
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => ({
  checkQmdBinaryAvailability,
}));

vi.mock("../../manager-runtime.js", () => ({
  MemoryIndexManager: {
    get: mockMemoryIndexGet,
  },
  closeAllMemoryIndexManagers: mockCloseAllMemoryIndexManagers,
}));

import { QmdMemoryManager } from "./qmd-manager.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./search-manager.js";
const createQmdManagerMock = vi.mocked(QmdMemoryManager.create);

type QmdManagerInstance = Awaited<ReturnType<typeof QmdMemoryManager.create>>;
type SearchManagerResult = Awaited<ReturnType<typeof getMemorySearchManager>>;
type SearchManager = NonNullable<SearchManagerResult["manager"]>;

function createQmdCfg(
  agentId: string,
  workspace: string = "/tmp/workspace",
  qmd: Record<string, unknown> = {},
): OpenClawConfig {
  return {
    memory: { backend: "qmd", qmd },
    agents: { list: [{ id: agentId, default: true, workspace }] },
  };
}

function createBuiltinCfg(agentId: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: "/tmp/workspace",
        memorySearch: {
          provider: "openai",
          model: "text-embedding-3-small",
          store: {
            path: "/tmp/index.sqlite",
            vector: { enabled: false },
          },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
          sources: ["memory"],
          experimental: { sessionMemory: false },
        },
      },
      list: [{ id: agentId, default: true, workspace: "/tmp/workspace" }],
    },
  } as OpenClawConfig;
}

function requireManager(result: SearchManagerResult): SearchManager {
  if (!result.manager) {
    throw new Error("manager missing");
  }
  return result.manager;
}

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

async function createFailedQmdSearchHarness(params: { agentId: string; errorMessage: string }) {
  const cfg = createQmdCfg(params.agentId);
  mockPrimary.search.mockRejectedValueOnce(new Error(params.errorMessage));
  const first = await getMemorySearchManager({ cfg, agentId: params.agentId });
  return { cfg, manager: requireManager(first), firstResult: first };
}

async function expectPendingQmdReplacement(params: {
  agentId: string;
  firstCfg: OpenClawConfig;
  secondCfg: OpenClawConfig;
  firstAvailability: { command: string; cwd: string };
  secondAvailability: { command: string; cwd: string };
}) {
  const firstPrimary = createQmdManagerInstanceMock();
  const secondPrimary = createQmdManagerInstanceMock();
  const firstGate = createDeferred<QmdManagerInstance>();
  const secondGate = createDeferred<QmdManagerInstance>();
  createQmdManagerMock
    .mockImplementationOnce(async () => await firstGate.promise)
    .mockImplementationOnce(async () => await secondGate.promise);

  const firstPromise = getMemorySearchManager({
    cfg: params.firstCfg,
    agentId: params.agentId,
  });
  await Promise.resolve();
  const secondPromise = getMemorySearchManager({
    cfg: params.secondCfg,
    agentId: params.agentId,
  });
  await vi.waitFor(() => {
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
  });

  firstGate.resolve(firstPrimary as unknown as QmdManagerInstance);
  await vi.waitFor(() => {
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
  });

  secondGate.resolve(secondPrimary as unknown as QmdManagerInstance);
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  requireManager(first);
  requireManager(second);
  expect(first.manager).not.toBe(second.manager);
  expect(firstPrimary.close).toHaveBeenCalledTimes(1);
  expect(checkQmdBinaryAvailability).toHaveBeenNthCalledWith(1, {
    command: params.firstAvailability.command,
    env: process.env,
    cwd: nativePath(params.firstAvailability.cwd),
  });
  expect(checkQmdBinaryAvailability).toHaveBeenNthCalledWith(2, {
    command: params.secondAvailability.command,
    env: process.env,
    cwd: nativePath(params.secondAvailability.cwd),
  });
}

beforeEach(async () => {
  await closeAllMemorySearchManagers();
  mockPrimary.search.mockClear();
  mockPrimary.readFile.mockClear();
  mockPrimary.status.mockClear();
  mockPrimary.sync.mockClear();
  mockPrimary.probeEmbeddingAvailability.mockClear();
  mockPrimary.probeVectorAvailability.mockClear();
  mockPrimary.close.mockClear();
  fallbackSearch.mockClear();
  fallbackManager.readFile.mockClear();
  fallbackManager.status.mockClear();
  fallbackManager.sync.mockClear();
  fallbackManager.probeEmbeddingAvailability.mockClear();
  fallbackManager.probeVectorAvailability.mockClear();
  fallbackManager.close.mockClear();
  mockCloseAllMemoryIndexManagers.mockClear();
  mockMemoryIndexGet.mockClear();
  mockMemoryIndexGet.mockResolvedValue(fallbackManager);
  checkQmdBinaryAvailability.mockClear();
  checkQmdBinaryAvailability.mockResolvedValue({ available: true });
  createQmdManagerMock.mockClear();
});

describe("getMemorySearchManager caching", () => {
  it("repairs an invalid shared singleton cache shape before using qmd cache maps", async () => {
    await closeAllMemorySearchManagers();
    vi.resetModules();
    const cacheKey = Symbol.for("openclaw.memorySearchManagerCache");
    (globalThis as Record<PropertyKey, unknown>)[cacheKey] = {};

    const freshModule = await import("./search-manager.js");
    try {
      const result = await freshModule.getMemorySearchManager({
        cfg: createQmdCfg("corrupt-cache-agent"),
        agentId: "corrupt-cache-agent",
      });
      const managerStatus = requireManager(result).status();
      expect(managerStatus.backend).toBe("qmd");
      expect(managerStatus.requestedProvider).toBe("qmd");
    } finally {
      await freshModule.closeAllMemorySearchManagers();
      delete (globalThis as Record<PropertyKey, unknown>)[cacheKey];
    }
  });

  it("reuses the same QMD manager instance for repeated calls", async () => {
    const cfg = createQmdCfg("main");

    const first = await getMemorySearchManager({ cfg, agentId: "main" });
    const second = await getMemorySearchManager({ cfg, agentId: "main" });

    expect(first.manager).toBe(second.manager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(1);
  });

  it("evicts failed qmd wrapper so next call retries qmd", async () => {
    const retryAgentId = "retry-agent";
    const {
      cfg,
      manager: firstManager,
      firstResult: first,
    } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });

    const fallbackResults = await firstManager.search("hello");
    expect(fallbackResults).toHaveLength(1);
    expect(fallbackResults[0]?.path).toBe("MEMORY.md");

    const second = await getMemorySearchManager({ cfg, agentId: retryAgentId });
    requireManager(second);
    expect(second.manager).not.toBe(first.manager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
  });

  it("falls back immediately when the qmd binary is unavailable", async () => {
    const cfg = createQmdCfg("missing-qmd");
    checkQmdBinaryAvailability.mockResolvedValueOnce({
      available: false,
      error: "spawn qmd ENOENT",
    });

    const result = await getMemorySearchManager({ cfg, agentId: "missing-qmd" });
    const manager = requireManager(result);
    const searchResults = await manager.search("hello");

    expect(createQmdManagerMock).not.toHaveBeenCalled();
    expect(mockMemoryIndexGet).toHaveBeenCalled();
    expect(searchResults).toHaveLength(1);
  });

  it("backs off repeated full qmd open failures until the cooldown expires", async () => {
    const agentId = "qmd-open-cooldown";
    const cfg = createQmdCfg(agentId);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    createQmdManagerMock.mockRejectedValueOnce(new Error("Cannot find package 'chokidar'"));

    try {
      const first = await getMemorySearchManager({ cfg, agentId });
      const second = await getMemorySearchManager({ cfg, agentId });

      expect(first.manager).toBe(fallbackManager);
      expect(second.manager).toBe(fallbackManager);
      expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
      expect(checkQmdBinaryAvailability).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(62_001);
      const third = await getMemorySearchManager({ cfg, agentId });
      const thirdManager = requireManager(third);

      expect(thirdManager.status().backend).toBe("qmd");
      expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
      expect(checkQmdBinaryAvailability).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("lets status probes bypass and clear a full qmd open-failure cooldown", async () => {
    const agentId = "qmd-open-status-bypass";
    const cfg = createQmdCfg(agentId);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    createQmdManagerMock.mockRejectedValueOnce(new Error("Cannot find package 'chokidar'"));

    try {
      const first = await getMemorySearchManager({ cfg, agentId });
      expect(first.manager).toBe(fallbackManager);
      expect(createQmdManagerMock).toHaveBeenCalledTimes(1);

      const status = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
      expect(requireManager(status).status().backend).toBe("qmd");
      expect(createQmdManagerMock).toHaveBeenCalledTimes(2);

      const full = await getMemorySearchManager({ cfg, agentId });
      expect(requireManager(full).status().backend).toBe("qmd");
      expect(createQmdManagerMock).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("probes qmd availability from the agent workspace", async () => {
    const agentId = "workspace-probe";
    const cfg = createQmdCfg(agentId);

    await getMemorySearchManager({ cfg, agentId });

    expect(checkQmdBinaryAvailability).toHaveBeenCalledWith({
      command: "qmd",
      env: process.env,
      cwd: nativePath("/tmp/workspace"),
    });
  });

  it("creates a missing agent workspace before probing qmd availability", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-workspace-"));
    const workspace = path.join(tempRoot, "missing", "workspace");
    const agentId = "missing-workspace";
    const cfg = {
      memory: { backend: "qmd", qmd: {} },
      agents: { list: [{ id: agentId, default: true, workspace }] },
    } as OpenClawConfig;

    try {
      await getMemorySearchManager({ cfg, agentId });

      const stat = await fs.stat(workspace);
      expect(stat.isDirectory()).toBe(true);
      expect(checkQmdBinaryAvailability).toHaveBeenCalledWith({
        command: "qmd",
        env: process.env,
        cwd: workspace,
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns a cached qmd manager without probing the binary again", async () => {
    const agentId = "cached-qmd";
    const cfg = createQmdCfg(agentId);

    const first = await getMemorySearchManager({ cfg, agentId });
    const second = await getMemorySearchManager({ cfg, agentId });

    requireManager(first);
    requireManager(second);
    expect(first.manager).toBe(second.manager);
    expect(checkQmdBinaryAvailability).toHaveBeenCalledTimes(1);
  });

  it("reuses cached full qmd manager across normalized agent ids", async () => {
    const cfg = createQmdCfg("Main-Agent");

    const first = await getMemorySearchManager({ cfg, agentId: "Main-Agent" });
    const second = await getMemorySearchManager({ cfg, agentId: "main-agent" });

    requireManager(first);
    requireManager(second);
    expect(first.manager).toBe(second.manager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
    const createParams = createQmdManagerMock.mock.calls[0]?.[0];
    expect(createParams?.agentId).toBe("main-agent");
    expect(createParams?.mode).toBe("full");
  });

  it("replaces cached full qmd manager across different workspaces", async () => {
    const agentId = "cached-qmd-workspace-reload";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace-a");
    const secondCfg = createQmdCfg(agentId, "/tmp/workspace-b");
    const firstPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    const secondPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    createQmdManagerMock
      .mockImplementationOnce(async () => firstPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => secondPrimary as unknown as QmdManagerInstance);

    const first = await getMemorySearchManager({ cfg: firstCfg, agentId });
    const firstManager = requireManager(first);
    const second = await getMemorySearchManager({ cfg: secondCfg, agentId });
    const secondManager = requireManager(second);

    expect(firstManager).not.toBe(secondManager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
    expect(firstPrimary.close).toHaveBeenCalledTimes(1);
    await expect(firstManager.search("hello")).rejects.toThrow("replaced by a newer qmd manager");
    expect(() => firstManager.status()).toThrow("replaced by a newer qmd manager");
    expect(checkQmdBinaryAvailability).toHaveBeenNthCalledWith(1, {
      command: "qmd",
      env: process.env,
      cwd: nativePath("/tmp/workspace-a"),
    });
    expect(checkQmdBinaryAvailability).toHaveBeenNthCalledWith(2, {
      command: "qmd",
      env: process.env,
      cwd: nativePath("/tmp/workspace-b"),
    });
  });

  it("replaces cached full qmd manager when context limits change", async () => {
    const agentId = "cached-qmd-context-limits-reload";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace");
    const secondCfg = {
      ...createQmdCfg(agentId, "/tmp/workspace"),
      agents: {
        list: [
          {
            id: agentId,
            default: true,
            workspace: "/tmp/workspace",
            contextLimits: {
              memoryGetMaxChars: 24_000,
              memoryGetDefaultLines: 180,
            },
          },
        ],
      },
    } as OpenClawConfig;
    const firstPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    const secondPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    createQmdManagerMock
      .mockImplementationOnce(async () => firstPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => secondPrimary as unknown as QmdManagerInstance);

    const first = await getMemorySearchManager({ cfg: firstCfg, agentId });
    const second = await getMemorySearchManager({ cfg: secondCfg, agentId });

    requireManager(first);
    requireManager(second);
    expect(first.manager).not.toBe(second.manager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
    expect(firstPrimary.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing cached full qmd manager when replacement creation fails", async () => {
    const agentId = "cached-qmd-failed-replacement";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace-a");
    const secondCfg = createQmdCfg(agentId, "/tmp/workspace-b");
    const firstPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    createQmdManagerMock.mockImplementationOnce(
      async () => firstPrimary as unknown as QmdManagerInstance,
    );
    checkQmdBinaryAvailability
      .mockResolvedValueOnce({ available: true })
      .mockResolvedValueOnce({ available: false, error: "spawn qmd ENOENT" });

    const first = await getMemorySearchManager({ cfg: firstCfg, agentId });
    const firstManager = requireManager(first);
    const replacementAttempt = await getMemorySearchManager({ cfg: secondCfg, agentId });

    expect(replacementAttempt.manager).toBe(fallbackManager);
    expect(firstPrimary.close).not.toHaveBeenCalled();
    await expect(firstManager.search("hello")).resolves.toStrictEqual([]);

    const firstAgain = await getMemorySearchManager({ cfg: firstCfg, agentId });
    expect(firstAgain.manager).toBe(firstManager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent full qmd manager creation for the same agent", async () => {
    const agentId = "pending-qmd";
    const cfg = createQmdCfg(agentId);
    const createGate = createDeferred<QmdManagerInstance>();
    createQmdManagerMock.mockImplementationOnce(async () => await createGate.promise);

    const firstPromise = getMemorySearchManager({ cfg, agentId });
    const secondPromise = getMemorySearchManager({ cfg, agentId });

    createGate.resolve(mockPrimary as unknown as QmdManagerInstance);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    requireManager(first);
    requireManager(second);
    expect(first.manager).toBe(second.manager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
    expect(checkQmdBinaryAvailability).toHaveBeenCalledTimes(1);
  });

  it("serializes pending full qmd creation before replacing it for a different workspace", async () => {
    const agentId = "pending-qmd-workspace-reload";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace-a");
    const secondCfg = createQmdCfg(agentId, "/tmp/workspace-b");
    await expectPendingQmdReplacement({
      agentId,
      firstCfg,
      secondCfg,
      firstAvailability: { command: "qmd", cwd: "/tmp/workspace-a" },
      secondAvailability: { command: "qmd", cwd: "/tmp/workspace-b" },
    });
  });

  it("serializes pending full qmd creation before replacing it for a different qmd config", async () => {
    const agentId = "pending-qmd-config-reload";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace", { command: "qmd" });
    const secondCfg = createQmdCfg(agentId, "/tmp/workspace", { command: "qmd-alt" });
    await expectPendingQmdReplacement({
      agentId,
      firstCfg,
      secondCfg,
      firstAvailability: { command: "qmd", cwd: "/tmp/workspace" },
      secondAvailability: { command: "qmd-alt", cwd: "/tmp/workspace" },
    });
  });

  it("reuses pending full qmd creation when raw cfg differs but qmd inputs match", async () => {
    const agentId = "pending-qmd-unrelated-config";
    const firstCfg = createQmdCfg(agentId);
    const secondCfg = {
      ...createQmdCfg(agentId),
      session: { store: "/tmp/alternate-session-store.json" },
    } as OpenClawConfig;
    const createGate = createDeferred<QmdManagerInstance>();
    createQmdManagerMock.mockImplementationOnce(async () => await createGate.promise);

    const firstPromise = getMemorySearchManager({ cfg: firstCfg, agentId });
    await Promise.resolve();
    const secondPromise = getMemorySearchManager({ cfg: secondCfg, agentId });

    createGate.resolve(mockPrimary as unknown as QmdManagerInstance);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    requireManager(first);
    requireManager(second);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
    expect(first.manager).toBe(second.manager);
    expect(checkQmdBinaryAvailability).toHaveBeenCalledTimes(1);
  });

  it("does not cache qmd managers for status-only requests", async () => {
    const agentId = "status-agent";
    const cfg = createQmdCfg(agentId);

    const first = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
    const second = await getMemorySearchManager({ cfg, agentId, purpose: "status" });

    requireManager(first);
    requireManager(second);
    const firstStatus = requireManager(first).status();
    expect(firstStatus.backend).toBe("qmd");
    expect(firstStatus.provider).toBe("qmd");
    expect(firstStatus.model).toBe("qmd");
    expect(firstStatus.requestedProvider).toBe("qmd");
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
    expect(mockMemoryIndexGet).not.toHaveBeenCalled();

    await first.manager?.close?.();
    await second.manager?.close?.();
    expect(mockPrimary.close).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached full qmd managers for one-shot CLI requests", async () => {
    const agentId = "cli-agent";
    const cfg = createQmdCfg(agentId);
    const fullPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    const cliPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    createQmdManagerMock
      .mockImplementationOnce(async () => fullPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => cliPrimary as unknown as QmdManagerInstance);

    const full = await getMemorySearchManager({ cfg, agentId });
    const cli = await getMemorySearchManager({ cfg, agentId, purpose: "cli" });
    const fullManager = requireManager(full);
    const cliManager = requireManager(cli);

    expect(cliManager).toBe(cliPrimary);
    expect(cliManager).not.toBe(fullManager);
    const fullCreateParams = createQmdManagerMock.mock.calls[0]?.[0];
    const cliCreateParams = createQmdManagerMock.mock.calls[1]?.[0];
    expect(fullCreateParams?.agentId).toBe(agentId);
    expect(fullCreateParams?.mode).toBe("full");
    expect(cliCreateParams?.agentId).toBe(agentId);
    expect(cliCreateParams?.mode).toBe("cli");

    await cli.manager?.close?.();
    expect(cliPrimary.close).toHaveBeenCalledTimes(1);
    expect(fullPrimary.close).not.toHaveBeenCalled();

    const fullAgain = await getMemorySearchManager({ cfg, agentId });
    expect(fullAgain.manager).toBe(fullManager);
  });

  it("does not cache builtin managers for status-only requests", async () => {
    const agentId = "builtin-status-agent";
    const cfg = createBuiltinCfg(agentId);
    const firstBuiltinManager = createManagerMock({
      backend: "builtin",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
    });
    const secondBuiltinManager = createManagerMock({
      backend: "builtin",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
    });
    mockMemoryIndexGet
      .mockResolvedValueOnce(firstBuiltinManager)
      .mockResolvedValueOnce(secondBuiltinManager);

    const first = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
    const second = await getMemorySearchManager({ cfg, agentId, purpose: "status" });

    expect(first.manager).toBe(firstBuiltinManager);
    expect(second.manager).toBe(secondBuiltinManager);
    expect(second.manager).not.toBe(first.manager);
    expect(mockMemoryIndexGet).toHaveBeenCalledTimes(2);

    await first.manager?.close?.();
    await second.manager?.close?.();
    expect(firstBuiltinManager.close).toHaveBeenCalledTimes(1);
    expect(secondBuiltinManager.close).toHaveBeenCalledTimes(1);
  });

  it("reports real qmd index counts for status-only requests", async () => {
    const agentId = "status-counts-agent";
    const cfg = createQmdCfg(agentId);
    mockPrimary.status.mockReturnValueOnce({
      ...createManagerStatus({
        backend: "qmd",
        provider: "qmd",
        model: "qmd",
        requestedProvider: "qmd",
        withMemorySourceCounts: true,
      }),
      files: 10,
      chunks: 42,
      sourceCounts: [{ source: "memory" as const, files: 10, chunks: 42 }],
    });

    const result = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
    const manager = requireManager(result);

    const status = manager.status();
    expect(status.backend).toBe("qmd");
    expect(status.files).toBe(10);
    expect(status.chunks).toBe(42);
    expect(status.sourceCounts).toEqual([{ source: "memory", files: 10, chunks: 42 }]);
    const createParams = createQmdManagerMock.mock.calls[0]?.[0];
    expect(createParams?.agentId).toBe(agentId);
    expect(createParams?.mode).toBe("status");
  });

  it("reuses cached full qmd manager for status-only requests", async () => {
    const agentId = "status-reuses-full-agent";
    const cfg = createQmdCfg(agentId);

    const full = await getMemorySearchManager({ cfg, agentId });
    const status = await getMemorySearchManager({ cfg, agentId, purpose: "status" });

    requireManager(full);
    requireManager(status);
    expect(status.manager).not.toBe(full.manager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(1);
    await status.manager?.close?.();
    expect(mockPrimary.close).not.toHaveBeenCalled();

    const fullAgain = await getMemorySearchManager({ cfg, agentId });
    expect(fullAgain.manager).toBe(full.manager);
  });

  it("does not borrow a cached full qmd manager for status across different workspaces", async () => {
    const agentId = "status-workspace-reload";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace-a");
    const secondCfg = createQmdCfg(agentId, "/tmp/workspace-b");
    const firstPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    const secondStatusManager = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    createQmdManagerMock
      .mockImplementationOnce(async () => firstPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => secondStatusManager as unknown as QmdManagerInstance);

    const full = await getMemorySearchManager({ cfg: firstCfg, agentId });
    const fullManager = requireManager(full);
    const status = await getMemorySearchManager({ cfg: secondCfg, agentId, purpose: "status" });

    requireManager(status);
    expect(status.manager).toBe(secondStatusManager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
    expect(firstPrimary.close).not.toHaveBeenCalled();
    expect(checkQmdBinaryAvailability).toHaveBeenNthCalledWith(1, {
      command: "qmd",
      env: process.env,
      cwd: nativePath("/tmp/workspace-a"),
    });
    expect(checkQmdBinaryAvailability).toHaveBeenNthCalledWith(2, {
      command: "qmd",
      env: process.env,
      cwd: nativePath("/tmp/workspace-b"),
    });

    const fullAgain = await getMemorySearchManager({ cfg: firstCfg, agentId });
    expect(fullAgain.manager).toBe(fullManager);
  });

  it("gets a fresh qmd manager for later status requests after close", async () => {
    const agentId = "status-eviction-agent";
    const cfg = createQmdCfg(agentId);

    const first = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
    const firstManager = requireManager(first);
    await firstManager.close?.();

    const second = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
    requireManager(second);

    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
    expect(mockPrimary.close).toHaveBeenCalledTimes(1);
  });

  it("does not evict a newer cached wrapper when closing an older failed wrapper", async () => {
    const retryAgentId = "retry-agent-close";
    const {
      cfg,
      manager: firstManager,
      firstResult: first,
    } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    await firstManager.search("hello");

    const second = await getMemorySearchManager({ cfg, agentId: retryAgentId });
    const secondManager = requireManager(second);
    expect(second.manager).not.toBe(first.manager);

    await firstManager.close?.();

    const third = await getMemorySearchManager({ cfg, agentId: retryAgentId });
    expect(third.manager).toBe(secondManager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
  });

  it("falls back to builtin search when qmd fails with sqlite busy", async () => {
    const retryAgentId = "retry-agent-busy";
    const { manager: firstManager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd index busy while reading results: SQLITE_BUSY: database is locked",
    });

    const results = await firstManager.search("hello");
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("MEMORY.md");
    expect(fallbackSearch).toHaveBeenCalledTimes(1);
  });

  it("keeps original qmd error when fallback manager initialization fails", async () => {
    const retryAgentId = "retry-agent-no-fallback-auth";
    const { manager: firstManager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    mockMemoryIndexGet.mockRejectedValueOnce(new Error("No API key found for provider openai"));

    await expect(firstManager.search("hello")).rejects.toThrow("qmd query failed");
  });

  it("closes cached managers on global teardown", async () => {
    const cfg = createQmdCfg("teardown-agent");
    const first = await getMemorySearchManager({ cfg, agentId: "teardown-agent" });
    const firstManager = requireManager(first);

    await closeAllMemorySearchManagers();

    expect(mockPrimary.close).toHaveBeenCalledTimes(1);
    expect(mockCloseAllMemoryIndexManagers).toHaveBeenCalledTimes(1);

    const second = await getMemorySearchManager({ cfg, agentId: "teardown-agent" });
    const secondManager = requireManager(second);
    expect(secondManager).not.toBe(firstManager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
  });

  it("waits for pending full qmd manager creation during global teardown", async () => {
    const agentId = "teardown-pending-qmd";
    const cfg = createQmdCfg(agentId);
    const createGate = createDeferred<QmdManagerInstance>();
    createQmdManagerMock.mockImplementationOnce(async () => await createGate.promise);

    const firstPromise = getMemorySearchManager({ cfg, agentId });
    await Promise.resolve();

    const closePromise = closeAllMemorySearchManagers();
    await Promise.resolve();

    createGate.resolve(mockPrimary as unknown as QmdManagerInstance);

    const first = await firstPromise;
    const firstManager = requireManager(first);
    await closePromise;

    expect(mockPrimary.close).toHaveBeenCalledTimes(1);

    const second = await getMemorySearchManager({ cfg, agentId });
    expect(second.manager).not.toBe(firstManager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
  });

  it("closes builtin index managers on teardown after runtime is loaded", async () => {
    const retryAgentId = "teardown-with-fallback";
    const { manager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    await manager.search("hello");

    await closeAllMemorySearchManagers();

    expect(mockCloseAllMemoryIndexManagers).toHaveBeenCalledTimes(1);
  });
});

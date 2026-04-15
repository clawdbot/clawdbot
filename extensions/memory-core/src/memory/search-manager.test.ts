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

const mockPrimary = vi.hoisted(() => ({
  ...createManagerMock({
    backend: "qmd",
    provider: "qmd",
    model: "qmd",
    requestedProvider: "qmd",
    withMemorySourceCounts: true,
  }),
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

type SearchManagerResult = Awaited<ReturnType<typeof getMemorySearchManager>>;
type SearchManager = NonNullable<SearchManagerResult["manager"]>;

function createQmdCfg(agentId: string): OpenClawConfig {
  return {
    memory: { backend: "qmd", qmd: {} },
    agents: { list: [{ id: agentId, default: true, workspace: "/tmp/workspace" }] },
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
  expect(result.manager).toBeTruthy();
  if (!result.manager) {
    throw new Error("manager missing");
  }
  return result.manager;
}

async function createFailedQmdSearchHarness(params: { agentId: string; errorMessage: string }) {
  const cfg = createQmdCfg(params.agentId);
  mockPrimary.search.mockRejectedValueOnce(new Error(params.errorMessage));
  const first = await getMemorySearchManager({ cfg, agentId: params.agentId });
  return { cfg, manager: requireManager(first), firstResult: first };
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

  it("probes qmd availability from the agent workspace", async () => {
    const agentId = "workspace-probe";
    const cfg = createQmdCfg(agentId);

    await getMemorySearchManager({ cfg, agentId });

    expect(checkQmdBinaryAvailability).toHaveBeenCalledWith({
      command: "qmd",
      env: process.env,
      cwd: "/tmp/workspace",
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

  it("does not cache qmd managers for status-only requests", async () => {
    const agentId = "status-agent";
    const cfg = createQmdCfg(agentId);

    const first = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
    const second = await getMemorySearchManager({ cfg, agentId, purpose: "status" });

    requireManager(first);
    requireManager(second);
    expect(first.manager?.status()).toMatchObject({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
    });
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
    expect(mockMemoryIndexGet).not.toHaveBeenCalled();

    await first.manager?.close?.();
    await second.manager?.close?.();
    expect(mockPrimary.close).toHaveBeenCalledTimes(2);
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

    expect(manager.status()).toMatchObject({
      backend: "qmd",
      files: 10,
      chunks: 42,
      sourceCounts: [{ source: "memory", files: 10, chunks: 42 }],
    });
    expect(createQmdManagerMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ agentId, mode: "status" }),
    );
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
    expect(second.manager).toBeTruthy();
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

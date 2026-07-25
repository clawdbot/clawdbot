// Memory Core tests cover manager.fts only reindex plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

const createEmbeddingProviderMock = vi.hoisted(() => vi.fn());
const originalFtsOnlyStateDir = process.env.OPENCLAW_STATE_DIR;
const OPENAI_API_KEY_MISSING = 'No API key found for provider "openai".';
const MEMORY_FILE_CONTENT = "Alpha topic\n\nKeep this note.";

function setFtsOnlyStateDir(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

function restoreFtsOnlyStateDir(): void {
  if (originalFtsOnlyStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalFtsOnlyStateDir);
  }
}

function installDefaultEmbeddingProviderMock(): void {
  createEmbeddingProviderMock.mockImplementation(async () => ({
    requestedProvider: "auto",
    provider: null,
    providerUnavailableReason: "No embeddings provider available.",
  }));
}

function createAvailableOpenAiEmbeddingProviderResult() {
  return {
    requestedProvider: "openai",
    provider: {
      id: "openai",
      model: "text-embedding-3-small",
      embedQuery: async () => [1],
      embedBatch: async (texts: string[]) => texts.map(() => [1]),
    },
    runtime: { id: "openai" },
  };
}

function installAvailableOpenAiEmbeddingProviderMock(): void {
  createEmbeddingProviderMock.mockImplementation(async () =>
    createAvailableOpenAiEmbeddingProviderResult(),
  );
}

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createEmbeddingProviderMock,
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
}));

describe("memory manager FTS-only reindex", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fts-only-"));
  });

  beforeEach(async () => {
    createEmbeddingProviderMock.mockReset();
    installDefaultEmbeddingProviderMock();
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), MEMORY_FILE_CONTENT);
    setFtsOnlyStateDir(path.join(workspaceDir, "state"));
    indexPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    restoreFtsOnlyStateDir();
  });

  afterAll(async () => {
    await closeAllMemorySearchManagers();
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  async function createManager(
    params: {
      provider?: string;
      vectorEnabled?: boolean;
      onSearch?: boolean;
      extraPaths?: string[];
    } = {},
  ): Promise<MemoryIndexManager> {
    const store =
      params.vectorEnabled === undefined
        ? undefined
        : { vector: { enabled: params.vectorEnabled } };
    const cfg = {
      memory: {
        backend: "builtin",

        search: {
          provider: params.provider ?? "auto",
          model: "",
          extraPaths: params.extraPaths,
          store,
          cache: { enabled: false },
          sync: { watch: false, onSessionStart: false, onSearch: params.onSearch ?? false },
        },
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  function countChunksContaining(term: string): number {
    const db = new DatabaseSync(indexPath);
    try {
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM memory_index_chunks WHERE text LIKE ?`)
        .get(`%${term}%`) as { c: number } | undefined;
      return row?.c ?? 0;
    } finally {
      db.close();
    }
  }

  function writeExistingMeta(memoryManager: MemoryIndexManager, model: string): void {
    const metaAccess = memoryManager as unknown as {
      readMeta(): MemoryIndexMeta | null;
      writeMeta(meta: MemoryIndexMeta): void;
    };
    const existingMeta = metaAccess.readMeta();
    metaAccess.writeMeta({
      ...(existingMeta ?? {
        chunkTokens: 600,
        chunkOverlap: 120,
        sources: ["memory"],
      }),
      provider: "openai",
      model,
      providerKey: "semantic-provider-key",
      vectorDims: 1536,
    });
  }

  function expireOptionalProviderRetry(memoryManager: MemoryIndexManager): void {
    (
      memoryManager as unknown as {
        optionalProviderInitRetryAfterMs: number;
      }
    ).optionalProviderInitRetryAfterMs = Date.now() - 1;
  }

  function expectMissingOpenAiFtsOnly(memoryManager: MemoryIndexManager): void {
    expect(memoryManager.status().custom?.providerState).toEqual({
      mode: "fts-only",
      reason: OPENAI_API_KEY_MISSING,
      attemptedProviderId: "openai",
    });
  }

  function makeKeywordHit(pathname: string, source: "memory" | "sessions" = "memory") {
    return {
      id: `${source}:${pathname}:1`,
      path: pathname,
      startLine: 1,
      endLine: 1,
      score: 1,
      snippet: "",
      source,
      textScore: 1,
      pathScore: 0,
      exactPathSpecificity: 0 as const,
    };
  }

  async function createManagerAfterMissingOpenAiFallback(
    params: { vectorEnabled?: boolean; onSearch?: boolean } = {},
  ): Promise<MemoryIndexManager> {
    createEmbeddingProviderMock.mockRejectedValueOnce(new Error(OPENAI_API_KEY_MISSING));
    const memoryManager = await createManager(params);
    await memoryManager.sync({ force: true });
    expectMissingOpenAiFtsOnly(memoryManager);
    return memoryManager;
  }

  async function createManagerReadyForOpenAiRecovery(
    params: { vectorEnabled?: boolean; onSearch?: boolean } = {},
  ): Promise<MemoryIndexManager> {
    const memoryManager = await createManagerAfterMissingOpenAiFallback(params);
    installAvailableOpenAiEmbeddingProviderMock();
    expireOptionalProviderRetry(memoryManager);
    return memoryManager;
  }

  it("preserves indexed chunks across forced reindex in FTS-only mode", async () => {
    const memoryManager = await createManager();

    await memoryManager.sync({ force: true });
    const firstStatus = memoryManager.status();
    expect(firstStatus.chunks).toBeGreaterThan(0);
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);

    await memoryManager.sync({ force: true });
    const secondStatus = memoryManager.status();
    expect(secondStatus.chunks).toBeGreaterThan(0);
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("does not load the vector store while syncing providerless FTS-only memory", async () => {
    const memoryManager = await createManager();
    const progress = vi.fn();

    await memoryManager.sync({ force: true, progress });

    expect(progress).not.toHaveBeenCalledWith(
      expect.objectContaining({ label: "Loading vector extension…" }),
    );
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("uses FTS-only recall when implicit OpenAI provider initialization fails", async () => {
    createEmbeddingProviderMock.mockRejectedValue(new Error(OPENAI_API_KEY_MISSING));
    const memoryManager = await createManager();

    await memoryManager.sync({ force: true });

    expect(createEmbeddingProviderMock).toHaveBeenCalledOnce();
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
    expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expectMissingOpenAiFtsOnly(memoryManager);
  });

  it("retries optional provider initialization after FTS-only fallback", async () => {
    const memoryManager = await createManagerAfterMissingOpenAiFallback();
    installAvailableOpenAiEmbeddingProviderMock();
    expireOptionalProviderRetry(memoryManager);

    await expect(memoryManager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });

    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(2);
    expect(memoryManager.status().provider).toBe("openai");
    expect(memoryManager.status().custom?.providerState).toEqual({
      mode: "active",
      providerId: "openai",
    });
  });

  it("joins an in-flight optional provider retry for concurrent callers", async () => {
    const memoryManager = await createManagerAfterMissingOpenAiFallback();
    let resolveProvider: () => void = () => {};
    const providerReady = new Promise<
      ReturnType<typeof createAvailableOpenAiEmbeddingProviderResult>
    >((resolve) => {
      resolveProvider = () => resolve(createAvailableOpenAiEmbeddingProviderResult());
    });
    createEmbeddingProviderMock.mockImplementation(async () => await providerReady);
    expireOptionalProviderRetry(memoryManager);

    const firstProbe = memoryManager.probeEmbeddingAvailability();
    const secondProbe = memoryManager.probeEmbeddingAvailability();
    await vi.waitFor(() => expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(2));
    resolveProvider();

    await expect(Promise.all([firstProbe, secondProbe])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(memoryManager.status().provider).toBe("openai");
  });

  it("keeps lexical recall after optional provider recovery", async () => {
    const memoryManager = await createManagerReadyForOpenAiRecovery();

    const results = await memoryManager.search("Alpha topic", { minScore: 0, maxResults: 3 });

    expect(results.map((result) => result.path)).toContain("MEMORY.md");
    expect(memoryManager.status()).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
    });

    await memoryManager.sync({ force: true });

    expect(memoryManager.status()).toMatchObject({
      dirty: false,
      provider: "openai",
      model: "text-embedding-3-small",
    });
    expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
  });

  it("does not return deleted memory during optional provider recovery FTS fallback", async () => {
    const memoryManager = await createManagerReadyForOpenAiRecovery({ vectorEnabled: false });
    await expect(memoryManager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(Reflect.get(memoryManager, "syncing")).toBeNull());
    await fs.rm(path.join(workspaceDir, "MEMORY.md"));

    await expect(
      memoryManager.search("Alpha topic", { minScore: 0, maxResults: 3 }),
    ).resolves.toEqual([]);

    expect(memoryManager.status()).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
    });
  });

  it("preserves dirty state when optional provider recovery races with FTS-only sync", async () => {
    createEmbeddingProviderMock.mockRejectedValueOnce(new Error(OPENAI_API_KEY_MISSING));
    const memoryManager = await createManager({ vectorEnabled: false });
    const originalSyncMemoryFiles = Reflect.get(memoryManager, "syncMemoryFiles") as (params: {
      needsFullReindex: boolean;
      progress?: unknown;
    }) => Promise<void>;
    let releaseInitialSync: () => void = () => {};
    let releasedInitialSync = false;
    const initialSyncGate = new Promise<void>((resolve) => {
      releaseInitialSync = () => {
        releasedInitialSync = true;
        resolve();
      };
    });
    let initialSyncStarted: () => void = () => {};
    const initialSyncStartedPromise = new Promise<void>((resolve) => {
      initialSyncStarted = resolve;
    });
    let heldFirstSync = false;
    Reflect.set(
      memoryManager,
      "syncMemoryFiles",
      async (params: { needsFullReindex: boolean; progress?: unknown }) => {
        if (!heldFirstSync) {
          heldFirstSync = true;
          initialSyncStarted();
          await initialSyncGate;
        }
        return await originalSyncMemoryFiles.call(memoryManager, params);
      },
    );

    const initialSync = memoryManager.sync({ force: true });
    try {
      await initialSyncStartedPromise;
      expect(Reflect.get(memoryManager, "syncProviderGeneration")).toMatchObject({
        kind: "fts-only",
        provider: null,
      });
      expect(countChunksContaining("Alpha topic")).toBe(0);
      installAvailableOpenAiEmbeddingProviderMock();
      expireOptionalProviderRetry(memoryManager);

      await expect(memoryManager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
      releaseInitialSync();
      await initialSync;
      await vi.waitFor(() => expect(Reflect.get(memoryManager, "syncing")).toBeNull());
      await vi.waitFor(() =>
        expect(Reflect.get(memoryManager, "syncProviderGeneration")).toBeNull(),
      );

      expect(memoryManager.status()).toMatchObject({
        dirty: true,
        provider: "openai",
        model: "text-embedding-3-small",
      });
      expect(memoryManager.status().custom?.indexIdentity).toMatchObject({
        status: "mismatched",
      });
      await expect(
        memoryManager.search("Alpha topic", { minScore: 0, maxResults: 3 }),
      ).resolves.toEqual([expect.objectContaining({ path: "MEMORY.md" })]);

      await memoryManager.sync({ force: true });

      expect(memoryManager.status()).toMatchObject({
        dirty: false,
        provider: "openai",
        model: "text-embedding-3-small",
      });
      expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    } finally {
      if (!releasedInitialSync) {
        releaseInitialSync();
      }
      await initialSync.catch(() => undefined);
    }
  });

  it("clears cached probe failures when optional provider recovery happens during search", async () => {
    const memoryManager = await createManagerAfterMissingOpenAiFallback({ vectorEnabled: false });
    await expect(memoryManager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: false,
      error: OPENAI_API_KEY_MISSING,
    });
    installAvailableOpenAiEmbeddingProviderMock();
    expireOptionalProviderRetry(memoryManager);

    await expect(
      memoryManager.search("Alpha topic", { minScore: 0, maxResults: 3 }),
    ).resolves.toEqual([]);

    await expect(memoryManager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
  });

  it("keeps an already-valid semantic index valid after optional provider recovery", async () => {
    installAvailableOpenAiEmbeddingProviderMock();
    const memoryManager = await createManager({ vectorEnabled: false });
    await memoryManager.sync({ force: true });
    expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    await memoryManager.close();
    manager = null;
    await closeAllMemorySearchManagers();
    createEmbeddingProviderMock.mockRejectedValue(new Error(OPENAI_API_KEY_MISSING));
    const reloadedManager = await createManager({ vectorEnabled: false });
    await expect(
      reloadedManager.search("Alpha topic", { minScore: 0, maxResults: 3 }),
    ).resolves.toHaveLength(1);
    installAvailableOpenAiEmbeddingProviderMock();
    expireOptionalProviderRetry(reloadedManager);

    await expect(reloadedManager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });

    expect(reloadedManager.status()).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
    });
    expect(reloadedManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expect(Reflect.get(reloadedManager, "memoryFullRetryDirty")).toBe(false);
  });

  it("fails closed when an explicit OpenAI provider initialization fails", async () => {
    createEmbeddingProviderMock.mockImplementation(async () => {
      throw new Error(OPENAI_API_KEY_MISSING);
    });
    const memoryManager = await createManager({ provider: "openai" });

    await expect(memoryManager.sync({ force: true })).rejects.toThrow(OPENAI_API_KEY_MISSING);
  });

  it("keeps FTS recall for an existing semantic index when implicit OpenAI initialization fails", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync({ force: true });
    writeExistingMeta(memoryManager, "text-embedding-3-small");
    await memoryManager.close();
    manager = null;
    await closeAllMemorySearchManagers();
    createEmbeddingProviderMock.mockClear();
    createEmbeddingProviderMock.mockImplementation(async () => {
      throw new Error(OPENAI_API_KEY_MISSING);
    });
    const reloadedManager = await createManager({ onSearch: true });

    const results = await reloadedManager.search("Alpha topic", { minScore: 0, maxResults: 3 });

    expect(results.map((result) => result.path)).toContain("MEMORY.md");
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(
      Reflect.get(reloadedManager, "optionalProviderInitRetryAfterMs") as number,
    ).toBeGreaterThan(Date.now());
    await expect(
      reloadedManager.search("Alpha topic", { minScore: 0, maxResults: 3 }),
    ).resolves.not.toHaveLength(0);
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(reloadedManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expectMissingOpenAiFtsOnly(reloadedManager);
    await expect(reloadedManager.sync({ force: true })).rejects.toThrow(
      "Refusing to run sync in fts-only fallback mode to protect existing vector index (current model: text-embedding-3-small).",
    );
  });

  it("does not return deleted memory through read-only semantic FTS fallback", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync({ force: true });
    writeExistingMeta(memoryManager, "text-embedding-3-small");
    await fs.rm(path.join(workspaceDir, "MEMORY.md"));
    await memoryManager.close();
    manager = null;
    await closeAllMemorySearchManagers();
    createEmbeddingProviderMock.mockClear();
    createEmbeddingProviderMock.mockImplementation(async () => {
      throw new Error(OPENAI_API_KEY_MISSING);
    });
    const reloadedManager = await createManager({ onSearch: true });

    await expect(
      reloadedManager.search("Alpha topic", { minScore: 0, maxResults: 3 }),
    ).resolves.toEqual([]);

    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    expect(reloadedManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expectMissingOpenAiFtsOnly(reloadedManager);
  });

  it("filters removed external extra-path memory from read-only fallback hits", async () => {
    const extraDir = path.join(fixtureRoot, `external-${caseId}`);
    await fs.mkdir(extraDir, { recursive: true });
    const extraFile = path.join(extraDir, "extra.md");
    await fs.writeFile(extraFile, "Gamma private note");
    const memoryManager = await createManager({ extraPaths: [extraDir] });
    await memoryManager.sync({ force: true });
    const extraPath = path.relative(workspaceDir, extraFile).replace(/\\/g, "/");
    expect(countChunksContaining("Gamma private")).toBeGreaterThan(0);
    await memoryManager.close();
    manager = null;
    await closeAllMemorySearchManagers();
    const reloadedManager = await createManager({ extraPaths: [] });
    const filterReadOnlyFallbackKeywordResults = Reflect.get(
      reloadedManager,
      "filterReadOnlyFallbackKeywordResults",
    ) as (
      hits: Array<ReturnType<typeof makeKeywordHit>>,
    ) => Promise<Array<ReturnType<typeof makeKeywordHit>>>;

    const filtered = await filterReadOnlyFallbackKeywordResults.call(reloadedManager, [
      makeKeywordHit("MEMORY.md"),
      makeKeywordHit(extraPath),
    ]);

    expect(filtered.map((hit) => hit.path)).toEqual(["MEMORY.md"]);
  });

  it("drops session hits while filtering read-only fallback memory hits", async () => {
    const memoryManager = await createManager();
    const filterReadOnlyFallbackKeywordResults = Reflect.get(
      memoryManager,
      "filterReadOnlyFallbackKeywordResults",
    ) as (
      hits: Array<ReturnType<typeof makeKeywordHit>>,
    ) => Promise<Array<ReturnType<typeof makeKeywordHit>>>;

    const filtered = await filterReadOnlyFallbackKeywordResults.call(memoryManager, [
      makeKeywordHit("memory/deleted.md"),
      makeKeywordHit("sessions/recent.md", "sessions"),
    ]);

    expect(filtered.map((hit) => `${hit.source}:${hit.path}`)).toEqual([]);
  });

  it("replenishes read-only fallback candidates after filtering stale hits", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync({ force: true });
    const staleHit = makeKeywordHit("memory/deleted.md");
    const validHit = makeKeywordHit("MEMORY.md");
    const searchKeyword = vi.fn(async (term: string) =>
      term === "Alpha topic" ? [staleHit] : [validHit],
    );
    Reflect.set(memoryManager, "searchKeyword", searchKeyword);
    const searchReadOnlyFallbackKeywordResults = Reflect.get(
      memoryManager,
      "searchReadOnlyFallbackKeywordResults",
    ) as (
      query: string,
      candidates: number,
      options: { boostFallbackRanking?: boolean },
      sourceFilterList: Array<"memory" | "sessions">,
    ) => Promise<Array<ReturnType<typeof makeKeywordHit>>>;

    const results = await searchReadOnlyFallbackKeywordResults.call(
      memoryManager,
      "Alpha topic",
      1,
      { boostFallbackRanking: true },
      ["memory"],
    );

    expect(searchKeyword.mock.calls[0]?.[0]).toBe("Alpha topic");
    expect(searchKeyword.mock.calls.some((call) => call[0] !== "Alpha topic")).toBe(true);
    expect(results.map((hit) => hit.path)).toEqual(["MEMORY.md"]);
  });

  it("syncs explicit provider-none memory without resolving an embedding provider", async () => {
    const memoryManager = await createManager({ provider: "none", vectorEnabled: false });

    await memoryManager.sync({ force: true });

    expect(createEmbeddingProviderMock).not.toHaveBeenCalled();
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
    expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expect(memoryManager.status().custom?.providerState).toEqual({
      mode: "fts-only",
      reason: "No embedding provider available (FTS-only mode)",
      attemptedProviderId: "none",
    });
  });

  it("reports explicit provider-none probes as FTS-only without resolving providers", async () => {
    const memoryManager = await createManager({ provider: "none", vectorEnabled: false });

    await expect(memoryManager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: false,
      error: "No embedding provider available (FTS-only mode)",
    });

    expect(createEmbeddingProviderMock).not.toHaveBeenCalled();
    expect(memoryManager.status().custom?.providerState).toEqual({
      mode: "fts-only",
      reason: "No embedding provider available (FTS-only mode)",
      attemptedProviderId: "none",
    });
  });

  it("forces provider-none memory to FTS-only when vector config is omitted", async () => {
    const memoryManager = await createManager({ provider: "none" });

    await memoryManager.sync({ force: true });

    const status = memoryManager.status();
    expect(createEmbeddingProviderMock).not.toHaveBeenCalled();
    expect(status.vector).toMatchObject({ enabled: false });
    expect(status.custom?.indexIdentity).toEqual({ status: "valid" });
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("still initializes configured providers when vector storage is disabled", async () => {
    const memoryManager = await createManager({ provider: "auto", vectorEnabled: false });

    await memoryManager.sync({ force: true });

    expect(createEmbeddingProviderMock).toHaveBeenCalledOnce();
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("refreshes FTS-only indexed content after memory file updates", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync({ force: true });

    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "Beta refresh marker\n\nUpdated memory content.",
    );
    await memoryManager.sync({ force: true });

    expect(countChunksContaining("refresh marker")).toBeGreaterThan(0);
    expect(countChunksContaining("Alpha topic")).toBe(0);
  });

  it("aborts instead of downgrading an existing semantic index to FTS-only", async () => {
    const memoryManager = await createManager();
    writeExistingMeta(memoryManager, "mock-embed");

    await expect(memoryManager.sync({ force: true })).rejects.toThrow(
      "Refusing to run sync in fts-only fallback mode to protect existing vector index (current model: mock-embed).",
    );
    expect(memoryManager.status().provider).toBe("none");
    expect(memoryManager.status().custom?.providerState).toEqual({
      mode: "fts-only",
      reason: "No embeddings provider available.",
      attemptedProviderId: "auto",
    });
    expect(
      Reflect.get(memoryManager, "optionalProviderInitRetryAfterMs") as number,
    ).toBeGreaterThan(Date.now());
  });
});

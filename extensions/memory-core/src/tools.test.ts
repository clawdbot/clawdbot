import type { MemorySearchRuntimeDebug } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
// Memory Core tests cover tools plugin behavior.
import { clearMemoryPluginState } from "openclaw/plugin-sdk/memory-host-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_GET_TOOL_CONTRACT, MEMORY_SEARCH_TOOL_CONTRACT } from "./memory-tool-contract.js";
import {
  getMemoryCloseMockCalls,
  getMemorySearchManagerMockCalls,
  getMemorySearchManagerMockConfigs,
  getMemorySearchManagerMockParams,
  getMemorySyncMockCalls,
  resetMemoryToolMockState,
  setMemoryCloseImpl,
  setMemoryCustomStatus,
  setMemoryPendingSyncSources,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
  setMemorySearchManagerImpl,
  setMemorySourceCounts,
  setMemoryStatusDirty,
} from "./memory-tool-manager.test-mocks.js";
import { applyProjectRanking } from "./memory/project-ranking.js";
import { createMemorySearchTool, testing as memoryToolsTesting } from "./tools.js";
import { buildMemorySearchUnavailableResult } from "./tools.shared.js";
import {
  asOpenClawConfig,
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

const sessionStore = vi.hoisted(() => ({
  "agent:main:main": {
    sessionId: "thread-1",
    updatedAt: 2,
    sessionFile: "/tmp/sessions/thread-1.jsonl",
    chatType: "direct" as const,
  },
  "agent:main:webchat:direct:owner": {
    sessionId: "past-thread",
    updatedAt: 1,
    sessionFile: "/tmp/sessions/past-thread.jsonl",
    chatType: "direct" as const,
  },
}));

vi.mock("openclaw/plugin-sdk/session-transcript-hit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-hit")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({
      storePath: "(test)",
      store: sessionStore,
    })),
  };
});

describe("memory tool schemas", () => {
  it("uses flat corpus enums for provider tool compatibility", () => {
    expect(MEMORY_SEARCH_TOOL_CONTRACT.parameters.properties.corpus).toEqual({
      type: "string",
      enum: ["memory", "wiki", "all", "sessions"],
    });
    expect(MEMORY_GET_TOOL_CONTRACT.parameters.properties.corpus).toEqual({
      type: "string",
      enum: ["memory", "wiki", "all"],
    });
    expect(MEMORY_SEARCH_TOOL_CONTRACT.parameters.properties.lifecycle).toEqual({
      type: "string",
      enum: ["auto", "current", "all"],
    });
  });
});

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    clearMemoryPluginState();
    resetMemoryToolMockState({ searchImpl: async () => [] });
    memoryToolsTesting.resetMemorySearchToolCooldowns();
  });

  it("rejects fractional maxResults before searching", async () => {
    const tool = createMemorySearchToolOrThrow();

    await expect(
      tool.execute("fractional-max-results", {
        query: "hello",
        maxResults: 1.5,
      }),
    ).rejects.toThrow("maxResults must be a positive integer");

    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("rejects an unknown corpus before searching", async () => {
    const tool = createMemorySearchToolOrThrow();

    // An unvalidated corpus string must not fall through to an unrestricted
    // manager search that could surface recall-only indexed transcripts.
    await expect(
      tool.execute("unknown-corpus", {
        query: "hello",
        corpus: "everything",
      }),
    ).rejects.toThrow("corpus must be one of: memory, wiki, all, sessions");

    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("rejects malformed minScore before searching", async () => {
    const tool = createMemorySearchToolOrThrow();

    await expect(
      tool.execute("malformed-min-score", {
        query: "hello",
        minScore: "0.8junk",
      }),
    ).rejects.toThrow("minScore must be a finite number");

    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("passes string minScore through to memory search", async () => {
    let seenMinScore: number | undefined;
    setMemorySearchImpl(async (opts) => {
      seenMinScore = opts?.minScore;
      return [];
    });
    const tool = createMemorySearchToolOrThrow();

    await tool.execute("string-min-score", {
      query: "hello",
      minScore: "0.8",
    });

    expect(seenMinScore).toBe(0.8);
  });

  it("overfetches and filters governed lifecycle records for current-state queries", async () => {
    let seenMaxResults: number | undefined;
    setMemorySearchImpl(async (opts) => {
      seenMaxResults = opts?.maxResults;
      return [
        {
          path: "memory/semantic/old.md",
          startLine: 1,
          endLine: 2,
          score: 0.99,
          snippet: "old",
          source: "memory" as const,
        },
        {
          path: "memory/semantic/current.md",
          startLine: 1,
          endLine: 2,
          score: 0.8,
          snippet: "current",
          source: "memory" as const,
        },
      ];
    });
    setMemoryReadFileImpl(async (params) => ({
      status: "ok",
      text: `---\nschema_version: openclaw.semantic_memory.v2\nstatus: ${
        params.relPath.endsWith("old.md") ? "superseded" : "active"
      }\n---`,
      path: params.relPath,
    }));
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });

    const result = await tool.execute("current-lifecycle", {
      query: "what is the current gate?",
      maxResults: 2,
    });

    expect(seenMaxResults).toBe(8);
    expect((result.details as { results?: Array<{ path: string }> }).results).toEqual([
      expect.objectContaining({ path: "memory/semantic/current.md" }),
    ]);
  });

  it("preserves manager ranking when public scores omit path precedence", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "memory/z/body/foo.md",
        startLine: 1,
        endLine: 2,
        score: 1,
        textScore: 0.9,
        snippet: "exact basename with body relevance",
        source: "memory" as const,
      },
      {
        path: "memory/a/path/foo.md",
        startLine: 1,
        endLine: 2,
        score: 1,
        textScore: 0,
        snippet: "exact path-only basename",
        source: "memory" as const,
      },
      {
        path: "memory/b/foo.md.bak",
        startLine: 1,
        endLine: 2,
        score: 1,
        textScore: 0,
        snippet: "lower-specificity stem match",
        source: "memory" as const,
      },
      {
        path: "memory/semantic.md",
        startLine: 1,
        endLine: 2,
        score: 2,
        textScore: 1,
        snippet: "strong non-exact semantic match",
        source: "memory" as const,
      },
    ]);
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });

    const result = await tool.execute("ranked-stream", { query: "foo.md", corpus: "memory" });
    const details = result.details as { results: Array<{ path: string; score: number }> };

    expect(details.results.map((entry) => entry.path)).toEqual([
      "memory/z/body/foo.md",
      "memory/a/path/foo.md",
      "memory/b/foo.md.bak",
      "memory/semantic.md",
    ]);
    expect(details.results.map((entry) => entry.score)).toEqual([1, 1, 1, 2]);
  });

  it("excludes annotation carriers from surfaced search snippets", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet:
          "Keep the gateway local. <!-- trigger: gateway setup --> <!-- importance: 9 --> <!-- project: alpha-key -->",
        source: "memory" as const,
      },
    ]);
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });

    const result = await tool.execute("clean-snippet", { query: "gateway", corpus: "memory" });
    const details = result.details as { results: Array<{ snippet: string }> };
    expect(details.results[0]?.snippet).toBe("Keep the gateway local.");
  });

  it("passes the host local-service hook to tool memory managers", async () => {
    const acquireLocalService = vi.fn(async () => undefined);
    const tool = createMemorySearchTool({
      config: asOpenClawConfig({
        agents: { list: [{ id: "main", default: true }] },
      }),
      acquireLocalService,
    });
    if (!tool) {
      throw new Error("tool missing");
    }

    await tool.execute("local-service-hook", { query: "hello" });

    expect(getMemorySearchManagerMockParams()).toEqual([
      expect.objectContaining({ acquireLocalService }),
    ]);
  });

  it("returns explicit unavailable metadata for quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("quota", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    });
  });

  it("returns explicit unavailable metadata for missing node:sqlite failures", async () => {
    const error =
      "SQLite support is unavailable in this Node runtime (missing node:sqlite). No such built-in module: node:sqlite";
    setMemorySearchImpl(async () => {
      throw new Error(error);
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("missing-node-sqlite", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error,
      warning:
        "Memory search is unavailable because this OpenClaw Node runtime does not provide SQLite support.",
      action:
        "Run OpenClaw with a Node runtime that includes node:sqlite, then retry memory_search.",
    });
  });

  it("keeps explicit unavailable metadata overrides for missing node:sqlite reasons", () => {
    const result = buildMemorySearchUnavailableResult("missing node:sqlite", {
      warning: "custom warning",
      action: "custom action",
    });

    expectUnavailableMemorySearchDetails(result, {
      error: "missing node:sqlite",
      warning: "custom warning",
      action: "custom action",
    });
  });

  it("does not infer migration recovery from non-quota error text", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("embedding provider timeout; run openclaw doctor --fix");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("generic", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "embedding provider timeout; run openclaw doctor --fix",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
  });

  it("separates this tool's deadline from a provider error by provenance, not text", () => {
    // Same text, opposite guidance: only the caller's deadline flag decides.
    expect(
      buildMemorySearchUnavailableResult("memory_search timed out after 15s", {
        agentId: "recall",
        deadline: true,
      }),
    ).toMatchObject({
      warning: "Memory search did not finish within its time limit.",
      action:
        "Retry memory_search after a short wait: a memory-corpus timeout pauses retries for up to a minute. If memory-corpus timeouts persist, run: openclaw memory status --deep --agent recall, and rebuild with openclaw memory index --force --agent recall only if it reports the index dirty or incomplete",
    });
    expect(buildMemorySearchUnavailableResult("memory_search timed out after 15s")).toMatchObject({
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
    expect(buildMemorySearchUnavailableResult("embedding provider timeout")).toMatchObject({
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
  });

  it("treats a provider error worded like the deadline as a provider failure", async () => {
    // Only the deadline owner can tell these apart: the provider is free to
    // emit the very text this tool uses for its own timeout.
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      throw new Error("memory_search timed out after 15s");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("provider-worded-like-deadline", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "memory_search timed out after 15s",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
    // The cooldown replay must carry the same provenance, not re-derive it.
    const cooldownResult = await tool.execute("provider-worded-cooldown", { query: "hello again" });
    expectUnavailableMemorySearchDetails(cooldownResult.details, {
      error: "memory_search timed out after 15s",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
    expect(searchCalls).toBe(1);
  });

  it("returns unavailable metadata when memory search does not settle", async () => {
    vi.useFakeTimers();
    try {
      let searchCalls = 0;
      let searchSignal: AbortSignal | undefined;
      setMemorySearchImpl(async (opts) => {
        searchCalls += 1;
        searchSignal = opts?.signal;
        return await new Promise(() => {});
      });
      const tool = createMemorySearchToolOrThrow();

      const resultPromise = tool.execute("search-timeout", { query: "hello" });
      await vi.advanceTimersByTimeAsync(15_000);

      const result = await resultPromise;
      expectUnavailableMemorySearchDetails(result.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search did not finish within its time limit.",
        action:
          "Retry memory_search after a short wait: a memory-corpus timeout pauses retries for up to a minute. If memory-corpus timeouts persist, run: openclaw memory status --deep --agent main, and rebuild with openclaw memory index --force --agent main only if it reports the index dirty or incomplete",
      });
      // The deadline must abort the orphaned search, not just race past it.
      expect(searchSignal?.aborted).toBe(true);
      const cooldownResult = await tool.execute("search-cooldown", { query: "hello again" });
      expectUnavailableMemorySearchDetails(cooldownResult.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search did not finish within its time limit.",
        action:
          "Retry memory_search after a short wait: a memory-corpus timeout pauses retries for up to a minute. If memory-corpus timeouts persist, run: openclaw memory status --deep --agent main, and rebuild with openclaw memory index --force --agent main only if it reports the index dirty or incomplete",
      });
      expect(searchCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the timeout result when an abort-aware search rejects on abort", async () => {
    vi.useFakeTimers();
    try {
      setMemorySearchImpl(
        async (opts) =>
          await new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener(
              "abort",
              () => reject(new Error("openai-compatible embeddings query failed: aborted")),
              { once: true },
            );
          }),
      );
      const tool = createMemorySearchToolOrThrow();

      const resultPromise = tool.execute("abort-aware-timeout", { query: "hello" });
      await vi.advanceTimersByTimeAsync(15_000);

      const result = await resultPromise;
      expectUnavailableMemorySearchDetails(result.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search did not finish within its time limit.",
        action:
          "Retry memory_search after a short wait: a memory-corpus timeout pauses retries for up to a minute. If memory-corpus timeouts persist, run: openclaw memory status --deep --agent main, and rebuild with openclaw memory index --force --agent main only if it reports the index dirty or incomplete",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates caller cancellation without entering cooldown", async () => {
    const controller = new AbortController();
    const abortError = new Error("agent run cancelled");
    let searchCalls = 0;
    let firstSignal: AbortSignal | undefined;
    setMemorySearchImpl(async (opts) => {
      searchCalls += 1;
      if (searchCalls === 1) {
        firstSignal = opts?.signal;
        return await new Promise(() => {});
      }
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "retry after cancellation",
          source: "memory",
        },
      ];
    });
    const tool = createMemorySearchToolOrThrow();

    const cancelled = tool.execute("caller-abort", { query: "hello" }, controller.signal);
    await vi.waitFor(() => expect(firstSignal).toBeInstanceOf(AbortSignal));
    controller.abort(abortError);

    await expect(cancelled).rejects.toBe(abortError);
    expect(firstSignal?.aborted).toBe(true);
    expect(firstSignal?.reason).toBe(abortError);

    const retry = await tool.execute("caller-abort-retry", { query: "hello again" });
    expect((retry.details as { results?: unknown[] }).results).toHaveLength(1);
    expect(searchCalls).toBe(2);
  });

  it("propagates caller cancellation that arrives during one-shot cleanup", async () => {
    const controller = new AbortController();
    const abortError = new Error("agent run cancelled during cleanup");
    setMemorySearchImpl(async () => [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "result before cleanup",
        source: "memory",
      },
    ]);
    setMemoryCloseImpl(async () => await new Promise(() => {}));
    const tool = createMemorySearchToolOrThrow({ oneShotCliRun: true });

    const cancelled = tool.execute("cleanup-abort", { query: "hello" }, controller.signal);
    await vi.waitFor(() => expect(getMemoryCloseMockCalls()).toBe(1));
    controller.abort(abortError);

    await expect(cancelled).rejects.toBe(abortError);

    setMemoryCloseImpl(async () => {});
    const retry = await tool.execute("cleanup-abort-retry", { query: "hello again" });
    expect((retry.details as { results?: unknown[] }).results).toHaveLength(1);
  });

  it("re-resolves the manager once when a cached sqlite handle was closed", async () => {
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      if (searchCalls === 1) {
        throw new Error("database is not open");
      }
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Thread-hidden codename: ORBIT-22.",
          source: "memory" as const,
        },
      ];
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });
    const result = await tool.execute("closed-db", { query: "hidden thread codename" });

    expect((result.details as { results?: Array<{ path: string }> }).results).toEqual([
      {
        corpus: "memory",
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "Thread-hidden codename: ORBIT-22.",
        source: "memory",
      },
    ]);
    expect(searchCalls).toBe(2);
    expect(getMemorySearchManagerMockCalls()).toBe(2);
    expect(getMemorySearchManagerMockParams()).toEqual([
      expect.objectContaining({ purpose: undefined }),
      expect.objectContaining({ purpose: undefined }),
    ]);
    expect(getMemoryCloseMockCalls()).toBe(0);
  });

  it("re-resolves and closes one-shot CLI managers when a cached sqlite handle was closed", async () => {
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      if (searchCalls === 1) {
        throw new Error("database is not open");
      }
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "Thread-hidden codename: ORBIT-22.",
          source: "memory" as const,
        },
      ];
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
      oneShotCliRun: true,
    });
    const result = await tool.execute("closed-db-cli", { query: "hidden thread codename" });

    expect((result.details as { results?: Array<{ path: string }> }).results).toEqual([
      {
        corpus: "memory",
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "Thread-hidden codename: ORBIT-22.",
        source: "memory",
      },
    ]);
    expect(searchCalls).toBe(2);
    expect(getMemorySearchManagerMockCalls()).toBe(2);
    expect(getMemorySearchManagerMockParams()).toEqual([
      expect.objectContaining({ purpose: "cli" }),
      expect.objectContaining({ purpose: "cli" }),
    ]);
    expect(getMemoryCloseMockCalls()).toBe(1);
  });

  it("returns a zero-hit search without tool-owned sync or retry", async () => {
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      return [];
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });
    const result = await tool.execute("zero-hit-retry", { query: "hidden thread codename" });

    expect((result.details as { results?: unknown[] }).results).toEqual([]);
    expect(searchCalls).toBe(1);
    expect(getMemorySyncMockCalls()).toBe(0);
  });

  it("qualifies empty results when the manager reports a dirty index", async () => {
    setMemoryStatusDirty(true);
    setMemorySearchImpl(async () => []);
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });

    const result = await tool.execute("dirty-index", { query: "hidden codeword" });

    expect(result.details).toMatchObject({
      results: [],
      stale: true,
      warning: "Memory index is dirty. Search results may be incomplete.",
      action: "Run: openclaw memory status --index --agent main",
    });
    expect(getMemorySyncMockCalls()).toBe(0);
  });

  it("does not qualify results while session-only catch-up is in progress", async () => {
    setMemoryStatusDirty(true);
    setMemoryPendingSyncSources(["sessions"]);
    setMemorySearchImpl(async () => []);
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });

    const result = await tool.execute("session-catch-up", { query: "hidden codeword" });

    expect(result.details).toMatchObject({ results: [] });
    expect(result.details).not.toHaveProperty("stale");
    expect(result.details).not.toHaveProperty("warning");
    expect(result.details).not.toHaveProperty("action");
  });

  it("surfaces embedding bootstrap degradation when keyword search has no hits", async () => {
    let searchCalls = 0;
    setMemorySearchImpl(async (opts) => {
      searchCalls += 1;
      opts?.onDebug?.({
        backend: "builtin",
        embeddingBootstrap: {
          ok: false,
          provider: "openai",
          reason:
            'MissingProviderAuthError: No API key resolved for provider "openai" (auth mode: api-key, checked: OPENAI_API_KEY).',
          degradedTo: "keyword-only",
        },
      });
      return [];
    });
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });

    const result = await tool.execute("bootstrap-debug", { query: "unknown memory" });
    const details = result.details as {
      results?: unknown[];
      debug?: { embeddingBootstrap?: MemorySearchRuntimeDebug["embeddingBootstrap"] };
    };

    expect(details.results).toEqual([]);
    expect(details.debug?.embeddingBootstrap).toEqual({
      ok: false,
      provider: "openai",
      reason:
        'MissingProviderAuthError: No API key resolved for provider "openai" (auth mode: api-key, checked: OPENAI_API_KEY).',
      degradedTo: "keyword-only",
    });
    expect(searchCalls).toBe(1);
    expect(getMemorySyncMockCalls()).toBe(0);
  });

  it("returns unavailable metadata when the index identity is paused", async () => {
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      return [];
    });
    const reason = "index was built for provider openai, expected ollama";
    setMemoryCustomStatus({
      indexIdentity: {
        status: "mismatched",
        reason,
      },
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
      },
    });
    const result = await tool.execute("paused-index", { query: "hidden thread codename" });

    expectUnavailableMemorySearchDetails(result.details, {
      error: reason,
      warning:
        "Tell the user: memory search is paused because the memory index was built with a different embedding provider/model/settings.",
      action:
        "Tell the user to run: openclaw memory status --index or openclaw memory index --force.",
    });
    expect(searchCalls).toBe(1);
    expect(getMemorySyncMockCalls()).toBe(0);
  });

  it("includes manager acquisition timing and cache-state debug payload", async () => {
    setMemorySearchManagerImpl(async () => ({
      manager: {
        search: vi.fn(async () => {
          return [
            {
              path: "MEMORY.md",
              startLine: 1,
              endLine: 2,
              score: 0.9,
              snippet: "ramen",
              source: "memory",
            },
          ];
        }),
        readFile: vi.fn(),
        status: vi.fn(() => ({
          backend: "builtin",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          files: 0,
          chunks: 0,
          dirty: false,
          workspaceDir: "/tmp/workspace",
          dbPath: "/tmp/workspace/index.sqlite",
          sources: ["memory"],
          sourceCounts: [{ source: "memory", files: 0, chunks: 0 }],
        })),
        sync: vi.fn(async () => {}),
        probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
        probeVectorAvailability: vi.fn(async () => true),
      },
      debug: {
        backend: "builtin",
        purpose: "default",
        managerMs: 17,
      },
    }));
    setMemorySearchImpl(async () => [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "ramen",
        source: "memory",
      },
    ]);

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
      },
    });
    const result = await tool.execute("manager-debug", { query: "favorite food" });
    const details = result.details as {
      debug?: {
        backend?: string;
        managerMs?: number;
        toolMs?: number;
        outsideSearchMs?: number;
        hits?: number;
        searchMs?: number;
      };
    };

    expect(details.debug?.backend).toBe("builtin");
    expect(details.debug?.managerMs).toBe(17);
    expect(details.debug?.toolMs).toBeGreaterThanOrEqual(details.debug?.searchMs ?? 0);
    expect(details.debug?.outsideSearchMs).toBeGreaterThanOrEqual(0);
  });
});

describe("memory_search corpus labels", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  it("uses explicit plugin context agent over synthetic active-memory session keys", async () => {
    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        agents: {
          list: [
            { id: "main", default: true, memory: { search: { enabled: false } } },
            { id: "recall", memory: { search: { enabled: true } } },
          ],
        },
      }),
      agentId: "recall",
      agentSessionKey: "explicit:user-session:active-memory:abc123",
    });

    await tool.execute("recall", { query: "favorite food" });

    expect(getMemorySearchManagerMockParams().at(-1)?.agentId).toBe("recall");
  });

  it("re-resolves config when executing a previously created tool", async () => {
    const startupConfig = asOpenClawConfig({
      agents: {
        defaults: {},
        list: [{ id: "main", default: true }],
      },
      memory: {
        search: {
          provider: "ollama",
          model: "nomic-embed-text",
        },
      },
    });
    const patchedConfig = asOpenClawConfig({
      agents: {
        defaults: {},
        list: [{ id: "main", default: true }],
      },
      memory: {
        search: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
    });
    let liveConfig = startupConfig;
    const tool = createMemorySearchTool({
      config: startupConfig,
      getConfig: () => liveConfig,
    });
    if (!tool) {
      throw new Error("tool missing");
    }

    liveConfig = patchedConfig;
    await tool.execute("patched-config", { query: "provider switch" });

    expect(getMemorySearchManagerMockConfigs()).toEqual([patchedConfig]);
  });

  it("keeps ordinary memory_search on explicitly configured sources when recall indexing is enabled", async () => {
    let seenSources: readonly string[] | undefined;
    let seenMaxResults: number | undefined;
    setMemorySearchImpl(async (opts) => {
      seenSources = opts?.sources;
      seenMaxResults = opts?.maxResults;
      return [];
    });
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: {
          defaults: {},
          list: [{ id: "main", default: true }],
        },
        memory: {
          citations: "off",
          search: { rememberAcrossConversations: true },
        },
        tools: { sessions: { visibility: "all" } },
      },
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("ordinary-search", { query: "favorite food", maxResults: 3 });

    expect(seenSources).toEqual(["memory"]);
    expect(seenMaxResults).toBe(3);
  });

  it("applies active-project ranking through the production memory_search tool", async () => {
    let activeProjectKeys: string[] | undefined;
    setMemorySearchImpl(async (opts) => {
      activeProjectKeys = opts?.activeProjectKeys;
      return applyProjectRanking(
        [
          {
            path: "MEMORY.md",
            startLine: 2,
            endLine: 2,
            score: 0.9,
            snippet: "second active fact",
            source: "memory" as const,
            projectKey: "github.com/acme/Beta",
          },
          {
            path: "MEMORY.md",
            startLine: 1,
            endLine: 1,
            score: 0.8,
            snippet: "active fact",
            source: "memory" as const,
            projectKey: "github.com/acme/Alpha",
          },
          {
            path: "MEMORY.md",
            startLine: 3,
            endLine: 3,
            score: 0.85,
            snippet: "foreign fact",
            source: "memory" as const,
            projectKey: "github.com/acme/Gamma",
          },
        ],
        opts?.activeProjectKeys,
      );
    });
    const tool = createMemorySearchToolOrThrow({
      config: { memory: { citations: "off" } },
      activeProjectKeys: ["github.com/acme/Beta", "github.com/acme/Alpha"],
    });

    const result = await tool.execute("project-ranked-search", { query: "fact" });
    const details = result.details as { results: Array<{ snippet: string; score: number }> };

    expect(details.results.map((entry) => entry.snippet)).toEqual([
      "second active fact",
      "active fact",
      "foreign fact",
    ]);
    expect(activeProjectKeys).toEqual(["github.com/acme/Beta", "github.com/acme/Alpha"]);
    expect(details.results[0]?.score).toBeCloseTo(1.035);
    expect(details.results[1]?.score).toBeCloseTo(0.92);
    expect(details.results[2]?.score).toBeCloseTo(0.765);
  });

  it("does not let corpus=all broaden implicitly indexed recall transcripts", async () => {
    let seenSources: readonly string[] | undefined;
    setMemorySearchImpl(async (opts) => {
      seenSources = opts?.sources;
      return [
        {
          path: "sessions/private-group.jsonl",
          startLine: 1,
          endLine: 2,
          score: 0.95,
          snippet: "private transcript",
          source: "sessions" as const,
        },
      ];
    });
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: {
          defaults: {},
          list: [{ id: "main", default: true }],
        },
        memory: {
          citations: "off",
          search: { rememberAcrossConversations: true },
        },
        tools: { sessions: { visibility: "all" } },
      },
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("ordinary-search", {
      query: "favorite food",
      corpus: "all",
    });
    const details = result.details as { results: Array<{ source: string }> };

    expect(seenSources).toEqual(["memory"]);
    expect(details.results).toEqual([]);
  });

  it.each([
    { name: "recall-only session indexing", rememberAcrossConversations: true },
    { name: "disabled session indexing", rememberAcrossConversations: false },
  ])(
    "reports unavailable for corpus=sessions with $name instead of searching memory files",
    async ({ rememberAcrossConversations }) => {
      const tool = createMemorySearchToolOrThrow({
        config: {
          agents: { list: [{ id: "main", default: true }] },
          memory: { search: { rememberAcrossConversations } },
          tools: { sessions: { visibility: "all" } },
        },
        agentSessionKey: "agent:main:main",
      });

      const result = await tool.execute("sessions-unavailable", {
        query: "favorite food",
        corpus: "sessions",
      });

      expectUnavailableMemorySearchDetails(result.details, {
        error: "Session transcript search is not enabled.",
        warning: "Session transcript search is unavailable for this agent.",
        action:
          'Enable memory.search.experimental.sessionMemory and add "sessions" to memory.search.sources, then retry memory_search.',
      });
      expect(getMemorySearchManagerMockCalls()).toBe(0);
    },
  );

  it.each(["sessions", "all"] as const)(
    "preserves explicitly configured transcript search for corpus=%s",
    async (corpus) => {
      let seenSources: readonly string[] | undefined;
      setMemorySearchImpl(async (opts) => {
        seenSources = opts?.sources;
        return [];
      });
      const tool = createMemorySearchToolOrThrow({
        config: {
          agents: {
            defaults: {},
            list: [{ id: "main", default: true }],
          },
          memory: {
            citations: "off",
            search: {
              rememberAcrossConversations: true,
              sources: ["sessions"],
            },
          },
          tools: { sessions: { visibility: "all" } },
        },
        agentSessionKey: "agent:main:main",
      });

      await tool.execute("ordinary-search", { query: "favorite food", corpus });

      expect(seenSources).toEqual(["sessions"]);
    },
  );

  it.each([
    { visibility: "agent" as const, visible: true },
    { visibility: "self" as const, visible: false },
  ])(
    "keeps migrated isolated-DM reset recall within visibility=$visibility",
    async ({ visibility, visible }) => {
      let seenSources: readonly string[] | undefined;
      setMemorySearchImpl(async (opts) => {
        seenSources = opts?.sources;
        return [
          {
            path: "sessions/main/past-thread.jsonl.reset.2026-08-23T07-10-59.000Z",
            startLine: 1,
            endLine: 2,
            score: 0.9,
            snippet: "Retained pre-reset conversation fact",
            source: "sessions" as const,
          },
        ];
      });
      const tool = createMemorySearchToolOrThrow({
        config: {
          agents: { list: [{ id: "main", default: true }] },
          session: { dmScope: "per-channel-peer" },
          memory: {
            citations: "off",
            search: {
              rememberAcrossConversations: false,
              experimental: { sessionMemory: true },
              sources: ["memory", "sessions"],
            },
          },
          tools: { sessions: { visibility } },
        },
        agentSessionKey: "agent:main:main",
      });

      const result = await tool.execute("isolated-session-search", {
        query: "pre-reset conversation",
        corpus: "sessions",
      });
      const details = result.details as { results: Array<{ corpus: string; snippet: string }> };

      expect(seenSources).toEqual(["sessions"]);
      expect(details.results).toEqual(
        visible
          ? [
              expect.objectContaining({
                corpus: "sessions",
                snippet: "Retained pre-reset conversation fact",
              }),
            ]
          : [],
      );
    },
  );

  it("forces trusted conversation recall onto its authorized transcript corpus", async () => {
    let seenSources: readonly string[] | undefined;
    setMemorySearchImpl(async (opts) => {
      seenSources = opts?.sources;
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 2,
          score: 0.95,
          snippet: "Shared memory note",
          source: "memory" as const,
        },
        {
          path: "sessions/past-thread.jsonl",
          startLine: 1,
          endLine: 2,
          score: 0.9,
          snippet: "Prior private conversation",
          source: "sessions" as const,
        },
      ];
    });
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
        tools: { sessions: { visibility: "self" } },
      },
      agentSessionKey: "agent:main:main:active-memory:abcdef123456",
      conversationRecall: {
        anchorSessionKey: "agent:main:main",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    const result = await tool.execute("trusted-recall", {
      query: "favorite food",
      corpus: "memory",
    });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(seenSources).toEqual(["sessions"]);
    expect(details.results).toEqual([
      expect.objectContaining({
        corpus: "sessions",
        path: "sessions/past-thread.jsonl",
      }),
    ]);
  });

  it("adds private transcript sources to combined advanced and product recall", async () => {
    let seenSources: readonly string[] | undefined;
    setMemorySearchImpl(async (opts) => {
      seenSources = opts?.sources;
      return [];
    });
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: {
          defaults: {},
          list: [{ id: "main", default: true }],
        },
        memory: {
          citations: "off",
          search: { rememberAcrossConversations: true },
        },
        tools: { sessions: { visibility: "self" } },
      },
      agentSessionKey: "agent:main:main",
      conversationRecall: {
        anchorSessionKey: "agent:main:main",
        scope: "same-agent-private",
        corpus: "configured",
      },
    });

    await tool.execute("combined-recall", { query: "favorite food" });

    expect(seenSources).toEqual(["memory", "sessions"]);
  });

  it("retains configured sources for advanced trusted recall", async () => {
    let seenSources: readonly string[] | undefined;
    setMemorySearchImpl(async (opts) => {
      seenSources = opts?.sources;
      return [
        {
          path: "MEMORY.md",
          startLine: 1,
          endLine: 2,
          score: 0.95,
          snippet: "Shared memory note",
          source: "memory" as const,
        },
        {
          path: "sessions/past-thread.jsonl",
          startLine: 1,
          endLine: 2,
          score: 0.9,
          snippet: "Prior private conversation",
          source: "sessions" as const,
        },
      ];
    });
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
        tools: { sessions: { visibility: "self" } },
      },
      agentSessionKey: "agent:main:main",
      conversationRecall: {
        anchorSessionKey: "agent:main:main",
        scope: "same-agent-private",
        corpus: "configured",
      },
    });

    const result = await tool.execute("advanced-recall", {
      query: "favorite food",
      corpus: "memory",
    });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(seenSources).toEqual(["memory"]);
    expect(details.results).toEqual([
      expect.objectContaining({ corpus: "memory", path: "MEMORY.md" }),
    ]);
  });

  it("widens ranked candidates to fill the visible session result window", async () => {
    const searchedLimits: Array<number | undefined> = [];
    const ranked = [
      {
        path: "sessions/missing-high-rank-a.jsonl",
        startLine: 1,
        endLine: 2,
        score: 0.99,
        snippet: "Invisible higher-ranked session",
        source: "sessions" as const,
      },
      {
        path: "sessions/missing-high-rank-b.jsonl",
        startLine: 3,
        endLine: 4,
        score: 0.98,
        snippet: "Another invisible higher-ranked session",
        source: "sessions" as const,
      },
      {
        path: "sessions/past-thread.jsonl",
        startLine: 5,
        endLine: 6,
        score: 0.9,
        snippet: "First visible session result",
        source: "sessions" as const,
      },
      {
        path: "sessions/past-thread.jsonl",
        startLine: 7,
        endLine: 8,
        score: 0.8,
        snippet: "Second visible session result",
        source: "sessions" as const,
      },
    ];
    setMemorySearchImpl(async (opts) => {
      searchedLimits.push(opts?.maxResults);
      return ranked.slice(0, opts?.maxResults);
    });
    setMemorySourceCounts([{ source: "sessions", files: 3, chunks: 4 }]);
    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: {
          citations: "off",
          search: {
            sources: ["sessions"],
            rememberAcrossConversations: true,
          },
        },
        tools: { sessions: { visibility: "self" } },
      },
      agentSessionKey: "agent:main:main:active-memory:abcdef123456",
      conversationRecall: {
        anchorSessionKey: "agent:main:main",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    const result = await tool.execute("visible-backfill", {
      query: "session result",
      corpus: "memory",
      maxResults: 2,
    });
    const details = result.details as {
      results: Array<{ path: string; snippet: string }>;
      debug?: {
        hits: number;
        candidateHits: number;
        withheldHits: number;
        searchWindow: number;
      };
    };

    expect(details.results.map((entry) => entry.snippet)).toEqual([
      "First visible session result",
      "Second visible session result",
    ]);
    expect(details.results).toHaveLength(2);
    expect(details.results.every((entry) => entry.path.startsWith("sessions/"))).toBe(true);
    expect(searchedLimits).toEqual([4]);
    expect(details.debug).toMatchObject({
      hits: 2,
      candidateHits: 4,
      withheldHits: 2,
      searchWindow: 4,
    });

    searchedLimits.length = 0;
    const boundedResult = await tool.execute("indexed-candidate-bound", {
      query: "session result",
      maxResults: 5,
    });
    expect(searchedLimits).toEqual([4]);
    expect(boundedResult.details).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ snippet: "First visible session result" }),
        expect.objectContaining({ snippet: "Second visible session result" }),
      ]),
      debug: { hits: 2, candidateHits: 4, withheldHits: 2, searchWindow: 4 },
    });

    searchedLimits.length = 0;
    setMemorySourceCounts([]);
    const bootstrapResult = await tool.execute("bootstrap-candidate-window", {
      query: "session result",
      maxResults: 2,
    });
    expect(searchedLimits).toEqual([200]);
    expect(bootstrapResult.details).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ snippet: "First visible session result" }),
        expect.objectContaining({ snippet: "Second visible session result" }),
      ]),
      debug: { hits: 2, candidateHits: 4, withheldHits: 2, searchWindow: 200 },
    });
  });

  it("preserves source corpus labels for memory and session transcript hits", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "MEMORY.md",
        startLine: 3,
        endLine: 4,
        score: 0.95,
        snippet: "Durable memory note",
        source: "memory" as const,
      },
      {
        path: "sessions/thread-1.jsonl",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "Thread transcript note",
        source: "sessions" as const,
      },
    ]);

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: {
          defaults: {},
          list: [{ id: "main", default: true }],
        },
        memory: {
          citations: "off",
          search: {
            sources: ["memory", "sessions"],
            rememberAcrossConversations: true,
          },
        },
        tools: { sessions: { visibility: "all" } },
      },
      agentSessionKey: "agent:main:main",
    });
    const result = await tool.execute("mixed", { query: "thread note" });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(details.results).toEqual([
      {
        corpus: "memory",
        path: "MEMORY.md",
        startLine: 3,
        endLine: 4,
        score: 0.95,
        snippet: "Durable memory note",
        source: "memory",
      },
      {
        corpus: "sessions",
        path: "sessions/thread-1.jsonl",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "Thread transcript note",
        source: "sessions",
      },
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

import type { MemorySearchRuntimeDebug } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
// Memory Core tests cover tools plugin behavior.
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMemoryCloseMockCalls,
  getMemorySearchManagerMockCalls,
  getMemorySearchManagerMockConfigs,
  getMemorySearchManagerMockParams,
  getMemorySyncMockCalls,
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemoryCloseImpl,
  setMemoryCustomStatus,
  setResolvedMemoryBackend,
  setMemorySearchImpl,
  setMemorySearchManagerImpl,
} from "./memory-tool-manager.test-mocks.js";
import {
  MEMORY_SEARCH_DEADLINE_CONTROL,
  type MemorySearchDeadlineAction,
} from "./memory/search-deadline.js";
import { createMemorySearchTool, testing as memoryToolsTesting } from "./tools.js";
import {
  buildMemorySearchUnavailableResult,
  MemoryGetSchema,
  MemorySearchSchema,
} from "./tools.shared.js";
import {
  asOpenClawConfig,
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

const sessionStore = vi.hoisted(() => ({
  "agent:main:main": {
    sessionId: "thread-1",
    updatedAt: 1,
    sessionFile: "/tmp/sessions/thread-1.jsonl",
  },
}));

const QMD_SEARCH_TIMEOUT_MS = 45_000;

function createQmdTimeoutSearchTool(options?: { oneShotCliRun?: boolean }) {
  return createMemorySearchToolOrThrow({
    config: asOpenClawConfig({
      agents: { list: [{ id: "main", default: true }] },
      memory: {
        backend: "qmd",
        qmd: { limits: { timeoutMs: QMD_SEARCH_TIMEOUT_MS } },
      },
    }),
    ...(options?.oneShotCliRun ? { oneShotCliRun: true } : {}),
  });
}

function expectMemorySearchTimeout(details: unknown, seconds: number): void {
  expectUnavailableMemorySearchDetails(details, {
    error: `memory_search timed out after ${seconds}s`,
    warning: "Memory search is unavailable due to an embedding/provider error.",
    action: "Check embedding provider configuration and retry memory_search.",
  });
}

type TestSearchOptions = {
  onDebug?: (debug: MemorySearchRuntimeDebug) => void;
  signal?: AbortSignal;
  [MEMORY_SEARCH_DEADLINE_CONTROL]?: (action: MemorySearchDeadlineAction) => void;
};

function createTestSearchManager(params: {
  backend: "builtin" | "qmd";
  search: (opts?: TestSearchOptions) => Promise<unknown[]>;
}) {
  return {
    search: vi.fn(async (_query: string, opts?: TestSearchOptions) => await params.search(opts)),
    status: () => ({
      backend: params.backend,
      provider: params.backend,
      workspaceDir: "/workspace",
    }),
    sync: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

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
    const searchCorpus = MemorySearchSchema.properties.corpus as {
      anyOf?: unknown;
      enum?: unknown;
    };
    const getCorpus = MemoryGetSchema.properties.corpus as {
      anyOf?: unknown;
      enum?: unknown;
    };

    expect(searchCorpus.anyOf).toBeUndefined();
    expect(searchCorpus.enum).toEqual(["memory", "wiki", "all", "sessions"]);
    expect(getCorpus.anyOf).toBeUndefined();
    expect(getCorpus.enum).toEqual(["memory", "wiki", "all"]);
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

  it("returns explicit unavailable metadata for non-quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("embedding provider timeout");
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("generic", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "embedding provider timeout",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
  });

  it("keeps qmd setup on the default deadline and closes a late one-shot manager", async () => {
    vi.useFakeTimers();
    try {
      setMemoryBackend("qmd");
      let resolveManager!: (result: { manager: { close: () => Promise<void> } }) => void;
      const close = vi.fn(async () => {});
      setMemorySearchManagerImpl(
        async () =>
          await new Promise((resolve) => {
            resolveManager = resolve;
          }),
      );
      const tool = createQmdTimeoutSearchTool({ oneShotCliRun: true });

      const resultPromise = tool.execute("late-manager", { query: "hello" });
      await vi.advanceTimersByTimeAsync(15_000);

      const result = await resultPromise;
      expectMemorySearchTimeout(result.details, 15);
      expect(close).not.toHaveBeenCalled();

      resolveManager({ manager: { close } });
      await vi.advanceTimersByTimeAsync(0);

      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
        warning: "Memory search is unavailable due to an embedding/provider error.",
        action: "Check embedding provider configuration and retry memory_search.",
      });
      // The deadline must abort the orphaned search, not just race past it.
      expect(searchSignal?.aborted).toBe(true);
      const cooldownResult = await tool.execute("search-cooldown", { query: "hello again" });
      expectUnavailableMemorySearchDetails(cooldownResult.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search is unavailable due to an embedding/provider error.",
        action: "Check embedding provider configuration and retry memory_search.",
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
        warning: "Memory search is unavailable due to an embedding/provider error.",
        action: "Check embedding provider configuration and retry memory_search.",
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

  it("allows qmd search to complete after the default deadline", async () => {
    vi.useFakeTimers();
    try {
      setMemoryBackend("qmd");
      let searchSignal: AbortSignal | undefined;
      setMemorySearchImpl(async (opts) => {
        searchSignal = opts?.signal;
        opts?.[MEMORY_SEARCH_DEADLINE_CONTROL]?.("pause");
        try {
          return await new Promise<unknown[]>((resolve) => {
            setTimeout(
              () =>
                resolve([
                  {
                    path: "MEMORY.md",
                    startLine: 1,
                    endLine: 1,
                    score: 0.9,
                    snippet: "slow qmd result",
                    source: "memory",
                  },
                ]),
              16_000,
            );
          });
        } finally {
          opts?.[MEMORY_SEARCH_DEADLINE_CONTROL]?.("resume");
        }
      });
      const tool = createQmdTimeoutSearchTool();

      let settled = false;
      const resultPromise = tool.execute("slow-qmd", { query: "hello" }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(settled).toBe(false);
      expect(searchSignal).toBeInstanceOf(AbortSignal);
      expect(searchSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);

      const result = await resultPromise;
      expect((result.details as { results?: unknown[] }).results).toHaveLength(1);
      expect(searchSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts qmd maintenance against the default deadline around the command phase", async () => {
    vi.useFakeTimers();
    try {
      setMemoryBackend("qmd");
      let searchSignal: AbortSignal | undefined;
      setMemorySearchImpl(
        async (opts) =>
          await new Promise<unknown[]>(() => {
            searchSignal = opts?.signal;
            setTimeout(() => {
              opts?.[MEMORY_SEARCH_DEADLINE_CONTROL]?.("pause");
              setTimeout(() => {
                opts?.[MEMORY_SEARCH_DEADLINE_CONTROL]?.("resume");
              }, 16_000);
            }, 10_000);
          }),
      );
      const tool = createQmdTimeoutSearchTool();

      let settled = false;
      const resultPromise = tool
        .execute("qmd-maintenance-timeout", { query: "hello" })
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(16_000);
      await vi.advanceTimersByTimeAsync(4_999);

      expect(settled).toBe(false);
      expect(searchSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;
      expectMemorySearchTimeout(result.details, 15);
      expect(searchSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds one-shot qmd cleanup with the default deadline", async () => {
    vi.useFakeTimers();
    try {
      setMemoryBackend("qmd");
      let searchSignal: AbortSignal | undefined;
      setMemorySearchImpl(async (opts) => {
        searchSignal = opts?.signal;
        opts?.[MEMORY_SEARCH_DEADLINE_CONTROL]?.("pause");
        try {
          return await new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("qmd query timed out after 45s")), 45_000);
          });
        } finally {
          opts?.[MEMORY_SEARCH_DEADLINE_CONTROL]?.("resume");
        }
      });
      setMemoryCloseImpl(async () => await new Promise(() => {}));
      const tool = createQmdTimeoutSearchTool({ oneShotCliRun: true });

      let settled = false;
      const resultPromise = tool
        .execute("qmd-cli-cleanup-timeout", { query: "hello" })
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(45_000);

      expect(searchSignal).toBeInstanceOf(AbortSignal);
      expect(searchSignal?.aborted).toBe(false);
      expect(getMemoryCloseMockCalls()).toBe(1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;
      expectUnavailableMemorySearchDetails(result.details, {
        error: "qmd query timed out after 45s",
        warning: "Memory search is unavailable due to an embedding/provider error.",
        action: "Check embedding provider configuration and retry memory_search.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps qmd-configured wiki-only searches on the default deadline", async () => {
    vi.useFakeTimers();
    try {
      setMemoryBackend("qmd");
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () => await new Promise(() => {}),
        get: async () => null,
      });
      const tool = createQmdTimeoutSearchTool();

      let settled = false;
      const resultPromise = tool
        .execute("qmd-wiki-timeout", { query: "hello", corpus: "wiki" })
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(settled).toBe(true);
      const result = await resultPromise;
      expectMemorySearchTimeout(result.details, 15);
      expect(getMemorySearchManagerMockCalls()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps qmd-to-builtin fallback searches on the default deadline", async () => {
    vi.useFakeTimers();
    try {
      setResolvedMemoryBackend("qmd");
      setMemoryBackend("builtin");
      let searchSignal: AbortSignal | undefined;
      setMemorySearchImpl(async (opts) => {
        searchSignal = opts?.signal;
        return await new Promise(() => {});
      });
      const tool = createQmdTimeoutSearchTool();

      let settled = false;
      const resultPromise = tool
        .execute("qmd-fallback-timeout", { query: "hello" })
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(settled).toBe(true);
      const result = await resultPromise;
      expectMemorySearchTimeout(result.details, 15);
      expect(searchSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps zero-hit one-shot qmd sync on the default deadline", async () => {
    vi.useFakeTimers();
    try {
      const manager = createTestSearchManager({ backend: "qmd", search: async () => [] });
      manager.sync.mockImplementation(async () => await new Promise(() => {}));
      setMemorySearchManagerImpl(async () => ({ manager }));
      const tool = createQmdTimeoutSearchTool({ oneShotCliRun: true });

      const resultPromise = tool
        .execute("qmd-zero-hit-sync-timeout", { query: "hello" })
        .then((result) => result);
      await vi.advanceTimersByTimeAsync(15_000);

      const result = await resultPromise;
      expectMemorySearchTimeout(result.details, 15);
      expect(manager.search).toHaveBeenCalledTimes(1);
      expect(manager.sync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps closed qmd manager reacquisition on the default deadline", async () => {
    vi.useFakeTimers();
    try {
      setResolvedMemoryBackend("qmd");
      const initial = createTestSearchManager({
        backend: "qmd",
        search: async () => {
          throw new Error("database is not open");
        },
      });
      let managerCalls = 0;
      setMemorySearchManagerImpl(async () => {
        managerCalls += 1;
        if (managerCalls === 1) {
          return { manager: initial };
        }
        return await new Promise(() => {});
      });
      const tool = createQmdTimeoutSearchTool();

      let settled = false;
      const resultPromise = tool.execute("closed-qmd-setup", { query: "hello" }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;
      expectMemorySearchTimeout(result.details, 15);
      expect(managerCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves refreshed qmd search on the qmd-owned deadline", async () => {
    vi.useFakeTimers();
    try {
      setResolvedMemoryBackend("qmd");
      const initial = createTestSearchManager({
        backend: "builtin",
        search: async () => {
          throw new Error("database is not open");
        },
      });
      let replacementSignal: AbortSignal | undefined;
      const replacement = createTestSearchManager({
        backend: "qmd",
        search: async (opts) => {
          replacementSignal = opts?.signal;
          opts?.[MEMORY_SEARCH_DEADLINE_CONTROL]?.("pause");
          try {
            return await new Promise((resolve) => {
              setTimeout(
                () =>
                  resolve([
                    {
                      path: "MEMORY.md",
                      startLine: 1,
                      endLine: 1,
                      score: 0.9,
                      snippet: "reacquired qmd result",
                      source: "memory",
                    },
                  ]),
                16_000,
              );
            });
          } finally {
            opts?.[MEMORY_SEARCH_DEADLINE_CONTROL]?.("resume");
          }
        },
      });
      let managerCalls = 0;
      setMemorySearchManagerImpl(async () => ({
        manager: managerCalls++ === 0 ? initial : replacement,
      }));
      const tool = createQmdTimeoutSearchTool();

      let settled = false;
      const resultPromise = tool
        .execute("closed-builtin-to-qmd", { query: "hello" })
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(settled).toBe(false);
      expect(replacementSignal).toBeInstanceOf(AbortSignal);
      expect(replacementSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;
      expect((result.details as { results?: unknown[] }).results).toHaveLength(1);
      expect(replacementSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

  it("forces a sync and retries once when the first search has zero hits", async () => {
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      if (searchCalls === 1) {
        return [];
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
    const result = await tool.execute("zero-hit-retry", { query: "hidden thread codename" });

    expect((result.details as { results?: Array<{ path: string }> }).results?.[0]?.path).toBe(
      "MEMORY.md",
    );
    expect(searchCalls).toBe(2);
  });

  it("keeps the zero-hit bootstrap retry for one-shot qmd searches", async () => {
    setMemoryBackend("qmd");
    let searchCalls = 0;
    setMemorySearchImpl(async () => {
      searchCalls += 1;
      if (searchCalls === 1) {
        return [];
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
        memory: { backend: "qmd", citations: "off" },
      },
      oneShotCliRun: true,
    });
    const result = await tool.execute("qmd-zero-hit-cli", {
      query: "hidden thread codename",
    });

    expect((result.details as { results?: Array<{ path: string }> }).results?.[0]?.path).toBe(
      "MEMORY.md",
    );
    expect(searchCalls).toBe(2);
    expect(getMemorySyncMockCalls()).toBe(1);
  });

  it("returns qmd runtime debug without forcing a zero-hit retry", async () => {
    setMemoryBackend("qmd");
    let searchCalls = 0;
    setMemorySearchImpl(async (opts) => {
      searchCalls += 1;
      opts?.onDebug?.({
        backend: "qmd",
        configuredMode: "search",
        effectiveMode: "search",
        qmd: {
          collectionValidation: {
            cacheState: "hit",
            elapsedMs: 2,
            collectionCount: 2,
            listCalls: 0,
            showCalls: 0,
          },
          multiCollectionProbe: {
            cacheState: "hit",
            elapsedMs: 1,
            supported: true,
          },
          searchPlan: {
            command: "search",
            collectionCount: 2,
            groupCount: 2,
            sources: ["memory", "sessions"],
          },
        },
      });
      return [];
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        agents: { list: [{ id: "main", default: true }] },
        memory: { backend: "qmd", citations: "off" },
      },
    });
    const result = await tool.execute("zero-hit-debug-single", {
      query: "hidden thread codename",
    });
    const details = result.details as {
      debug?: {
        effectiveMode?: string;
        fallback?: string;
        qmd?: MemorySearchRuntimeDebug["qmd"];
      };
    };

    expect((result.details as { results?: Array<unknown> }).results).toEqual([]);
    expect(searchCalls).toBe(1);
    expect(getMemorySyncMockCalls()).toBe(0);
    expect(details.debug?.effectiveMode).toBe("search");
    expect(details.debug?.fallback).toBeUndefined();
    expect(details.debug?.qmd?.collectionValidation).toMatchObject({
      cacheState: "hit",
      collectionCount: 2,
    });
    expect(details.debug?.qmd?.multiCollectionProbe).toMatchObject({
      cacheState: "hit",
      supported: true,
    });
    expect(details.debug?.qmd?.searchPlan).toEqual({
      command: "search",
      collectionCount: 2,
      groupCount: 2,
      sources: ["memory", "sessions"],
    });
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

  it("returns structured search debug metadata for qmd results", async () => {
    setMemoryBackend("qmd");
    setMemorySearchImpl(async (opts) => {
      opts?.onDebug?.({
        backend: "qmd",
        configuredMode: opts.qmdSearchModeOverride ?? "query",
        effectiveMode: "query",
        fallback: "unsupported-search-flags",
        qmd: {
          searchPlan: {
            command: "query",
            collectionCount: 2,
            groupCount: 2,
            sources: ["memory", "sessions"],
          },
        },
      });
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
    });

    const tool = createMemorySearchToolOrThrow({
      config: {
        plugins: {
          entries: {
            "active-memory": {
              config: {
                qmd: {
                  searchMode: "search",
                },
              },
            },
          },
        },
        memory: {
          backend: "qmd",
          qmd: {
            searchMode: "query",
            limits: {
              maxInjectedChars: 1000,
            },
          },
        },
      },
      agentSessionKey: "agent:main:main:active-memory:debug",
    });
    const result = await tool.execute("debug", { query: "favorite food" });
    const details = result.details as {
      mode?: unknown;
      debug?: {
        backend?: unknown;
        configuredMode?: unknown;
        effectiveMode?: unknown;
        fallback?: unknown;
        hits?: unknown;
        searchMs?: number;
        toolMs?: number;
        managerMs?: number;
        outsideSearchMs?: number;
        managerCacheState?: unknown;
        qmd?: {
          searchPlan?: {
            command?: unknown;
            collectionCount?: unknown;
            groupCount?: unknown;
            sources?: unknown;
          };
        };
      };
    };
    expect(details.mode).toBe("query");
    expect(details.debug?.backend).toBe("qmd");
    expect(details.debug?.configuredMode).toBe("search");
    expect(details.debug?.effectiveMode).toBe("query");
    expect(details.debug?.fallback).toBe("unsupported-search-flags");
    expect(details.debug?.hits).toBe(1);
    expect(details.debug?.searchMs).toBeGreaterThanOrEqual(0);
    expect(details.debug?.toolMs).toBeGreaterThanOrEqual(details.debug?.searchMs ?? 0);
    expect(details.debug?.outsideSearchMs).toBeGreaterThanOrEqual(0);
    expect(details.debug?.managerMs).toBeGreaterThanOrEqual(0);
    expect(details.debug?.managerCacheState).toBeUndefined();
    expect(details.debug?.qmd?.searchPlan).toEqual({
      command: "query",
      collectionCount: 2,
      groupCount: 2,
      sources: ["memory", "sessions"],
    });
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
          backend: "qmd",
          provider: "qmd",
          model: "qmd",
          requestedProvider: "qmd",
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
        managerMs: 17,
        managerCacheState: "cached-full-hit",
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
        memory: { backend: "qmd" },
      },
    });
    const result = await tool.execute("manager-debug", { query: "favorite food" });
    const details = result.details as {
      debug?: {
        backend?: string;
        managerMs?: number;
        toolMs?: number;
        outsideSearchMs?: number;
        managerCacheState?: string;
        hits?: number;
        searchMs?: number;
      };
    };

    expect(details.debug?.backend).toBe("qmd");
    expect(details.debug?.managerMs).toBe(17);
    expect(details.debug?.toolMs).toBeGreaterThanOrEqual(details.debug?.searchMs ?? 0);
    expect(details.debug?.outsideSearchMs).toBeGreaterThanOrEqual(0);
    expect(details.debug?.managerCacheState).toBe("cached-full-hit");
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
            { id: "main", default: true, memorySearch: { enabled: false } },
            { id: "recall", memorySearch: { enabled: true } },
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
        defaults: {
          memorySearch: {
            provider: "ollama",
            model: "nomic-embed-text",
          },
        },
        list: [{ id: "main", default: true }],
      },
      memory: {
        backend: "builtin",
      },
    });
    const patchedConfig = asOpenClawConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
          },
        },
        list: [{ id: "main", default: true }],
      },
      memory: {
        backend: "builtin",
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
        agents: { list: [{ id: "main", default: true }] },
        memory: { citations: "off" },
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

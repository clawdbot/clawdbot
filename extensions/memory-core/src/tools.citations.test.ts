// Memory Core tests cover tools.citations plugin behavior.
import fs from "node:fs/promises";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { readMemoryHostEvents } from "openclaw/plugin-sdk/memory-host-events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMemoryCloseMockCalls,
  getMemorySearchManagerMockCalls,
  getMemorySearchManagerMockParams,
  getReadAgentMemoryFileMockCalls,
  resetMemoryToolMockState,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
  setMemorySearchManagerImpl,
  setMemoryWorkspaceDir,
  type MemoryReadParams,
} from "./memory-tool-manager.test-mocks.js";
import {
  createMemoryCoreTestHarness,
  shortTermTestState as shortTermPromotionTesting,
} from "./test-helpers.js";
import {
  createMemoryGetTool,
  createMemorySearchTool,
  testing as memoryToolsTesting,
} from "./tools.js";
import {
  asOpenClawConfig,
  createAutoCitationsMemorySearchTool,
  createDefaultMemoryToolConfig,
  createMemoryGetToolOrThrow,
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

function collectWikiResultPaths(results: readonly { corpus: string; path: string }[]): string[] {
  const paths: string[] = [];
  for (const result of results) {
    if (result.corpus === "wiki") {
      paths.push(result.path);
    }
  }
  return paths;
}

async function waitFor<T>(task: () => Promise<T>, timeoutMs = 1500): Promise<T> {
  let value: T | undefined;
  await vi.waitFor(
    async () => {
      value = await task();
    },
    { interval: 1, timeout: timeoutMs },
  );
  return value as T;
}

beforeEach(() => {
  clearMemoryPluginState();
  memoryToolsTesting.resetMemorySearchToolCooldowns();
  resetMemoryToolMockState({
    searchImpl: async () => [
      {
        path: "MEMORY.md",
        startLine: 5,
        endLine: 7,
        score: 0.9,
        snippet: "@@ -5,3 @@\nAssistant: noted",
        source: "memory" as const,
      },
    ],
    readFileImpl: async (params: MemoryReadParams) => ({
      status: "ok",
      text: "",
      path: params.relPath,
      from: params.from ?? 1,
      lines: params.lines ?? 120,
    }),
  });
});

describe("memory search citations", () => {
  function expectFirstMemoryResult<T>(details: { results: T[] }): T {
    expect(details.results).toHaveLength(1);
    const [result] = details.results;
    if (!result) {
      throw new Error("Expected memory search result");
    }
    return result;
  }

  // The first tool call pays Vitest's cold lazy-runtime transform cost on Node 24 CI.
  it("appends source information when citations are enabled", async () => {
    const cfg = asOpenClawConfig({
      memory: { citations: "on" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_on", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).toMatch(/Source: MEMORY.md#L5-L7/);
    expect(firstResult.citation).toBe("MEMORY.md#L5-L7");
  }, 180_000);

  it("leaves snippet untouched when citations are off", async () => {
    const cfg = asOpenClawConfig({
      memory: { citations: "off" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_off", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).not.toMatch(/Source:/);
    expect(firstResult.citation).toBeUndefined();
  });

  it("honors auto mode for direct chats", async () => {
    const tool = createAutoCitationsMemorySearchTool("agent:main:discord:dm:u123");
    const result = await tool.execute("auto_mode_direct", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).toMatch(/Source:/);
  });

  it("suppresses citations for auto mode in group chats", async () => {
    const tool = createAutoCitationsMemorySearchTool("agent:main:discord:group:c123");
    const result = await tool.execute("auto_mode_group", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).not.toMatch(/Source:/);
  });
});

describe("memory tools", () => {
  it("returns unavailable details when memory_search fails (e.g. embeddings 429)", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const cfg = createDefaultMemoryToolConfig();
    const tool = createMemorySearchToolOrThrow({ config: cfg });

    const result = await tool.execute("call_1", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    });
  });

  it("uses default memory manager mode for shared memory_search", async () => {
    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        agents: { list: [{ id: "main", default: true }] },
      }),
    });

    await tool.execute("call_default_purpose", { query: "contact phrase" });

    expect(getMemorySearchManagerMockParams()).toEqual([
      expect.objectContaining({
        agentId: "main",
        purpose: undefined,
      }),
    ]);
    expect(getMemoryCloseMockCalls()).toBe(0);
  });

  it("uses one-shot CLI memory manager mode for explicit local CLI memory_search", async () => {
    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        agents: { list: [{ id: "main", default: true }] },
      }),
      oneShotCliRun: true,
    });

    await tool.execute("call_cli_purpose", { query: "contact phrase" });

    expect(getMemorySearchManagerMockParams()).toEqual([
      expect.objectContaining({
        agentId: "main",
        purpose: "cli",
      }),
    ]);
    expect(getMemoryCloseMockCalls()).toBe(1);
  });

  it("returns disabled details when memory_get fails", async () => {
    setMemoryReadFileImpl(async (_params: MemoryReadParams) => {
      throw new Error("path required");
    });

    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_2", { path: "memory/NOPE.md" });
    expect(result.details).toEqual({
      path: "memory/NOPE.md",
      text: "",
      disabled: true,
      error: "path required",
    });
  });

  it("returns an explicit not-found outcome when the file does not exist", async () => {
    setMemoryReadFileImpl(async (_params: MemoryReadParams) => {
      return { text: "", path: "memory/2026-02-19.md", status: "not_found" };
    });

    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_enoent", { path: "memory/2026-02-19.md" });
    expect(result.details).toEqual({
      text: "",
      path: "memory/2026-02-19.md",
      status: "not_found",
    });
  });

  it("uses the builtin direct memory file path for memory_get", async () => {
    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_builtin_fast_path", { path: "memory/2026-02-19.md" });

    expect(result.details).toEqual({
      status: "ok",
      text: "",
      path: "memory/2026-02-19.md",
      from: 1,
      lines: 120,
    });
    expect(getReadAgentMemoryFileMockCalls()).toBe(1);
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("revokes retained memory tools when live config disables memory", async () => {
    const startupConfig = asOpenClawConfig({
      agents: { list: [{ id: "main", default: true }] },
    });
    let liveConfig = startupConfig;
    const getConfig = () => liveConfig;
    const searchTool = createMemorySearchTool({ config: startupConfig, getConfig });
    const getTool = createMemoryGetTool({ config: startupConfig, getConfig });
    if (!searchTool || !getTool) {
      throw new Error("memory tools missing");
    }

    liveConfig = asOpenClawConfig({
      agents: {
        list: [{ id: "main", default: true, memory: { search: { enabled: false } } }],
      },
    });
    const disabledMessage =
      "Memory is disabled for this agent. Enable memory search for this agent, then retry.";
    await expect(
      searchTool.execute("revoked-search", { query: "private preference" }),
    ).rejects.toThrow(disabledMessage);
    await expect(getTool.execute("revoked-get", { path: "MEMORY.md" })).rejects.toThrow(
      disabledMessage,
    );
    expect(getMemorySearchManagerMockCalls()).toBe(0);
    expect(getReadAgentMemoryFileMockCalls()).toBe(0);
  });

  it("rejects fractional memory_get ranges before reading files", async () => {
    const tool = createMemoryGetToolOrThrow();

    await expect(
      tool.execute("call_fractional_range", {
        path: "memory/2026-02-19.md",
        from: 1.5,
        lines: 2,
      }),
    ).rejects.toThrow("from must be a positive integer");
    expect(getReadAgentMemoryFileMockCalls()).toBe(0);
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("returns truncation metadata and a continuation notice for partial memory_get results", async () => {
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
      status: "ok",
      path: params.relPath,
      text: "alpha\nbeta\n\n[More content available. Use from=41 to continue.]",
      from: params.from ?? 1,
      lines: 40,
      truncated: true,
      nextFrom: 41,
    }));

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_partial", { path: "memory/partial.md" });

    expect(result.details).toEqual({
      status: "ok",
      path: "memory/partial.md",
      text: "alpha\nbeta\n\n[More content available. Use from=41 to continue.]",
      from: 1,
      lines: 40,
      truncated: true,
      nextFrom: 41,
    });
  });

  it("persists short-term recall events from memory_search tool hits", async () => {
    const workspaceDir = await createTempWorkspace("memory-tools-recall-");
    try {
      setMemoryWorkspaceDir(workspaceDir);
      setMemorySearchImpl(async () => [
        {
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 2,
          score: 0.95,
          snippet: "Move backups to S3 Glacier.",
          source: "memory" as const,
        },
      ]);

      const tool = createMemorySearchToolOrThrow({
        config: asOpenClawConfig({
          agents: { list: [{ id: "main", default: true }] },
          plugins: {
            entries: {
              "memory-core": {
                config: {
                  dreaming: {
                    enabled: true,
                  },
                },
              },
            },
          },
        }),
      });
      await tool.execute("call_recall_persist", { query: "glacier backup" });

      const entries = await waitFor(async () => {
        const store = await shortTermPromotionTesting.readRecallStore(
          workspaceDir,
          new Date().toISOString(),
        );
        const values = Object.values(store.entries);
        expect(values).toHaveLength(1);
        return values;
      });
      const entry = entries[0];
      expect(entry?.path).toBe("memory/2026-04-03.md");
      expect(entry?.recallCount).toBe(1);
      const events = await waitFor(async () => {
        const memoryEvents = await readMemoryHostEvents({ workspaceDir });
        expect(memoryEvents).toHaveLength(1);
        return memoryEvents;
      });
      const event = events[0];
      expect(event?.type).toBe("memory.recall.recorded");
      if (!event || event.type !== "memory.recall.recorded") {
        throw new Error("expected memory recall recorded event");
      }
      expect(event.query).toBe("glacier backup");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("searches registered wiki corpus supplements without calling memory search", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "entities/alpha.md",
          title: "Alpha",
          kind: "entity",
          score: 4,
          snippet: "Alpha wiki entry",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_wiki_only", { query: "alpha", corpus: "wiki" });

    expect(result.details).toStrictEqual({
      results: [
        {
          corpus: "wiki",
          path: "entities/alpha.md",
          title: "Alpha",
          kind: "entity",
          score: 4,
          snippet: "Alpha wiki entry",
        },
      ],
      corpora: [{ corpus: "wiki", outcome: "ok" }],
      citations: "auto",
      debug: undefined,
      fallback: undefined,
      mode: undefined,
      model: undefined,
      provider: undefined,
    });
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it.each(["wiki", "all"] as const)(
    "forwards effective agent context to memory_search corpus=%s supplements",
    async (corpus) => {
      const search = vi.fn(async () => [
        {
          corpus: "wiki" as const,
          path: "entities/alpha.md",
          score: 4,
          snippet: "Alpha wiki entry",
        },
      ]);
      registerMemoryCorpusSupplement("memory-wiki", {
        search,
        get: async () => null,
      });
      const config = asOpenClawConfig({
        agents: { list: [{ id: "marketing-agent", default: true }] },
      });
      const tool = createMemorySearchTool({
        config,
        agentId: " Marketing Agent ",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      });
      if (!tool) {
        throw new Error("expected memory_search tool");
      }

      await tool.execute(`call_search_${corpus}`, {
        query: "alpha",
        maxResults: 3,
        corpus,
      });

      expect(search).toHaveBeenCalledWith({
        query: "alpha",
        maxResults: 3,
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      });
    },
  );

  it("includes memory results in corpus=all even when wiki scores are numerically higher (#77337)", async () => {
    // Wiki uses integer point scores (up to ~100+); memory uses cosine similarity (0-1).
    // Raw-score sort would starve memory hits when maxResults <= number of wiki hits.
    setMemorySearchImpl(async () => [
      {
        path: "memory/note-a.md",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "Memory result A",
        source: "memory" as const,
      },
    ]);
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "w1.md",
          title: "W1",
          kind: "entity",
          score: 50,
          snippet: "wiki 1",
        },
        {
          corpus: "wiki",
          path: "w2.md",
          title: "W2",
          kind: "entity",
          score: 40,
          snippet: "wiki 2",
        },
        {
          corpus: "wiki",
          path: "w3.md",
          title: "W3",
          kind: "entity",
          score: 30,
          snippet: "wiki 3",
        },
        {
          corpus: "wiki",
          path: "w4.md",
          title: "W4",
          kind: "entity",
          score: 20,
          snippet: "wiki 4",
        },
        {
          corpus: "wiki",
          path: "w5.md",
          title: "W5",
          kind: "entity",
          score: 10,
          snippet: "wiki 5",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_starvation", {
      query: "note",
      corpus: "all",
      maxResults: 5,
    });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };
    const corpora = details.results.map((r) => r.corpus);

    // Memory results must appear despite lower numeric scores, and the spare
    // memory quota should be backfilled by the remaining wiki result.
    expect(corpora).toContain("memory");
    expect(corpora).toContain("wiki");
    expect(details.results).toHaveLength(5);
    expect(collectWikiResultPaths(details.results)).toEqual(["w1.md", "w2.md", "w3.md", "w4.md"]);
  });

  it("preserves memory rank within balanced corpus results", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "memory/z/foo.md",
        startLine: 1,
        endLine: 2,
        score: 1,
        snippet: "exact filename",
        source: "memory" as const,
      },
      {
        path: "memory/a/semantic.md",
        startLine: 1,
        endLine: 2,
        score: 2,
        snippet: "non-exact semantic match",
        source: "memory" as const,
      },
    ]);
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "w1.md",
          title: "W1",
          kind: "entity",
          score: 10,
          snippet: "wiki 1",
        },
        {
          corpus: "wiki",
          path: "w2.md",
          title: "W2",
          kind: "entity",
          score: 9,
          snippet: "wiki 2",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_ranked_stream", {
      query: "foo.md",
      corpus: "all",
      maxResults: 4,
    });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(details.results.map((entry) => entry.path)).toEqual([
      "w1.md",
      "w2.md",
      "memory/z/foo.md",
      "memory/a/semantic.md",
    ]);
  });

  it("merges memory and wiki corpus search results for corpus=all", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "entities/alpha.md",
          title: "Alpha",
          kind: "entity",
          score: 1.1,
          snippet: "Alpha wiki entry",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_corpus", { query: "alpha", corpus: "all" });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
      ["wiki", "entities/alpha.md"],
      ["memory", "MEMORY.md"],
    ]);
    expect(getMemorySearchManagerMockCalls()).toBe(1);
  });

  it("does not cooldown primary memory when a corpus=all wiki supplement stalls", async () => {
    vi.useFakeTimers();
    try {
      let searchCalls = 0;
      setMemorySearchImpl(async () => {
        searchCalls += 1;
        return [
          {
            path: "MEMORY.md",
            startLine: 5,
            endLine: 7,
            score: 0.9,
            snippet: "@@ -5,3 @@\nAssistant: noted",
            source: "memory" as const,
          },
        ];
      });
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () => await new Promise(() => {}),
        get: async () => null,
      });

      const tool = createMemorySearchToolOrThrow();
      const stalledAllResultPromise = tool.execute("call_all_stalled_wiki", {
        query: "alpha",
        corpus: "all",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const stalledAllResult = await stalledAllResultPromise;
      expect(stalledAllResult.details).toMatchObject({
        results: [{ corpus: "memory", path: "MEMORY.md" }],
        corpora: [
          { corpus: "memory", outcome: "ok" },
          {
            corpus: "wiki",
            outcome: "unavailable",
            error: "memory_search timed out after 15s",
          },
        ],
        warning: expect.stringContaining("Wiki corpus unavailable"),
      });

      const memoryResult = await tool.execute("call_memory_after_stalled_wiki", {
        query: "alpha",
      });
      const details = memoryResult.details as { results: Array<{ corpus: string; path: string }> };
      expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
        ["memory", "MEMORY.md"],
      ]);
      expect(searchCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records an unregistered requested wiki corpus without hiding memory results", async () => {
    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_without_wiki", {
      query: "alpha",
      corpus: "all",
    });

    expect(result.details).toMatchObject({
      results: [{ corpus: "memory", path: "MEMORY.md" }],
      corpora: [
        { corpus: "memory", outcome: "ok" },
        { corpus: "wiki", outcome: "not-registered" },
      ],
      warning: expect.stringContaining("Wiki corpus is not registered"),
    });
  });

  it("surfaces a memory-corpus warning when corpus=all hits a returned manager error", async () => {
    setMemorySearchManagerImpl(async () => ({ error: "sqlite support missing" }));
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "entities/alpha.md",
          title: "Alpha",
          kind: "entity",
          score: 4,
          snippet: "Alpha wiki entry",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_manager_error", { query: "alpha", corpus: "all" });
    const details = result.details as {
      results: Array<{ corpus: string }>;
      warning?: string;
    };

    // Wiki supplements still serve, but the omitted memory corpus is recorded.
    expect(details.results.map((entry) => entry.corpus)).toEqual(["wiki"]);
    expect(details.warning).toContain("Memory corpus unavailable");
    expect(details.warning).toContain("sqlite support missing");
  });

  it("cooldowns primary memory when corpus=all memory search stalls", async () => {
    vi.useFakeTimers();
    try {
      let searchCalls = 0;
      setMemorySearchImpl(async () => {
        searchCalls += 1;
        return await new Promise(() => {});
      });
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () => [
          {
            corpus: "wiki",
            path: "entities/alpha.md",
            title: "Alpha",
            kind: "entity",
            score: 4,
            snippet: "Alpha wiki entry",
          },
        ],
        get: async () => null,
      });

      const tool = createMemorySearchToolOrThrow();
      const stalledAllResultPromise = tool.execute("call_all_stalled_memory", {
        query: "alpha",
        corpus: "all",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const stalledAllResult = await stalledAllResultPromise;
      expect(stalledAllResult.details).toMatchObject({
        results: [{ corpus: "wiki", path: "entities/alpha.md" }],
        corpora: [
          {
            corpus: "memory",
            outcome: "unavailable",
            error: "memory_search timed out after 15s",
          },
          { corpus: "wiki", outcome: "ok" },
        ],
        warning: expect.stringContaining("Memory corpus unavailable"),
      });

      const wikiOnlyResult = await tool.execute("call_all_after_stalled_memory", {
        query: "alpha",
        corpus: "all",
      });
      const details = wikiOnlyResult.details as {
        results: Array<{ corpus: string; path: string }>;
        corpora: Array<{ corpus: string; outcome: string; error?: string }>;
        warning?: string;
      };
      expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
        ["wiki", "entities/alpha.md"],
      ]);
      expect(details.corpora).toEqual([
        {
          corpus: "memory",
          outcome: "unavailable",
          error: "memory_search timed out after 15s",
        },
        { corpus: "wiki", outcome: "ok" },
      ]);
      expect(details.warning).toContain("Memory corpus unavailable");
      expect(details.warning).toContain("memory_search timed out after 15s");
      expect(searchCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

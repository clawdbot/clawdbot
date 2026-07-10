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
  setMemoryBackend,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
  setMemoryWorkspaceDir,
  type MemoryReadParams,
} from "./memory-tool-manager.test-mocks.js";
import { testing as shortTermPromotionTesting } from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";
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
    backend: "builtin",
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

  it("appends source information when citations are enabled", async () => {
    setMemoryBackend("builtin");
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
  });

  it("leaves snippet untouched when citations are off", async () => {
    setMemoryBackend("builtin");
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

  it("clamps decorated snippets to qmd injected budget", async () => {
    setMemoryBackend("qmd");
    const cfg = asOpenClawConfig({
      memory: { citations: "on", backend: "qmd", qmd: { limits: { maxInjectedChars: 20 } } },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_qmd", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet.length).toBeLessThanOrEqual(20);
  });

  it("honors auto mode for direct chats", async () => {
    setMemoryBackend("builtin");
    const tool = createAutoCitationsMemorySearchTool("agent:main:discord:dm:u123");
    const result = await tool.execute("auto_mode_direct", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).toMatch(/Source:/);
  });

  it("suppresses citations for auto mode in group chats", async () => {
    setMemoryBackend("builtin");
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
    setMemoryBackend("qmd");
    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        memory: { backend: "qmd", qmd: { command: "qmd" } },
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
    setMemoryBackend("qmd");
    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        memory: { backend: "qmd", qmd: { command: "qmd" } },
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

  it("returns empty text without error when file does not exist (ENOENT)", async () => {
    setMemoryReadFileImpl(async (_params: MemoryReadParams) => {
      return { text: "", path: "memory/2026-02-19.md", from: 1, lines: 0 };
    });

    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_enoent", { path: "memory/2026-02-19.md" });
    expect(result.details).toEqual({
      text: "",
      path: "memory/2026-02-19.md",
      from: 1,
      lines: 0,
    });
  });

  it("uses the builtin direct memory file path for memory_get", async () => {
    setMemoryBackend("builtin");
    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_builtin_fast_path", { path: "memory/2026-02-19.md" });

    expect(result.details).toEqual({
      text: "",
      path: "memory/2026-02-19.md",
      from: 1,
      lines: 120,
    });
    expect(getReadAgentMemoryFileMockCalls()).toBe(1);
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("rejects fractional memory_get ranges before reading files", async () => {
    setMemoryBackend("builtin");
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
    setMemoryBackend("builtin");
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
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
      setMemoryBackend("builtin");
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
        corpus,
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
      expectUnavailableMemorySearchDetails(stalledAllResult.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search is unavailable due to an embedding/provider error.",
        action: "Check embedding provider configuration and retry memory_search.",
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
      expectUnavailableMemorySearchDetails(stalledAllResult.details, {
        error: "memory_search timed out after 15s",
        warning: "Memory search is unavailable due to an embedding/provider error.",
        action: "Check embedding provider configuration and retry memory_search.",
      });

      const wikiOnlyResult = await tool.execute("call_all_after_stalled_memory", {
        query: "alpha",
        corpus: "all",
      });
      const details = wikiOnlyResult.details as {
        results: Array<{ corpus: string; path: string }>;
      };
      expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
        ["wiki", "entities/alpha.md"],
      ]);
      expect(searchCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a wiki corpus supplement for memory_get corpus=all", async () => {
    setMemoryReadFileImpl(async () => {
      throw new Error("path required");
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => ({
        corpus: "wiki",
        path: "entities/alpha.md",
        title: "Alpha",
        kind: "entity",
        content: "Alpha wiki entry",
        fromLine: 3,
        lineCount: 5,
      }),
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_fallback", {
      path: "entities/alpha.md",
      from: 3,
      lines: 5,
      corpus: "all",
    });

    expect(result.details).toEqual({
      corpus: "wiki",
      path: "entities/alpha.md",
      title: "Alpha",
      kind: "entity",
      text: "Alpha wiki entry",
      fromLine: 3,
      lineCount: 5,
    });
  });

  it.each(["wiki", "all"] as const)(
    "forwards effective agent context to memory_get corpus=%s supplements",
    async (corpus) => {
      if (corpus === "all") {
        setMemoryReadFileImpl(async () => {
          throw new Error("memory path missing");
        });
      }
      const get = vi.fn(async () => ({
        corpus: "wiki" as const,
        path: "entities/alpha.md",
        content: "Alpha wiki entry",
        fromLine: 2,
        lineCount: 4,
      }));
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () => [],
        get,
      });
      const config = asOpenClawConfig({
        agents: { list: [{ id: "marketing-agent", default: true }] },
      });
      const tool = createMemoryGetTool({
        config,
        agentId: " Marketing Agent ",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      });
      if (!tool) {
        throw new Error("expected memory_get tool");
      }

      await tool.execute(`call_get_${corpus}`, {
        path: "entities/alpha.md",
        from: 2,
        lines: 4,
        corpus,
      });

      expect(get).toHaveBeenCalledWith({
        lookup: "entities/alpha.md",
        fromLine: 2,
        lineCount: 4,
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
        corpus,
      });
    },
  );

  it("falls back to a wiki corpus supplement when memory_get corpus=all misses memory without throwing", async () => {
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
    }));
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => ({
        corpus: "wiki",
        path: "memory/entities/alpha.md",
        title: "Alpha",
        kind: "entity",
        content: "Alpha wiki entry after empty miss",
        fromLine: 3,
        lineCount: 5,
      }),
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_empty_miss_fallback", {
      path: "memory/entities/alpha.md",
      from: 3,
      lines: 5,
      corpus: "all",
    });

    expect(result.details).toEqual({
      corpus: "wiki",
      path: "memory/entities/alpha.md",
      title: "Alpha",
      kind: "entity",
      text: "Alpha wiki entry after empty miss",
      fromLine: 3,
      lineCount: 5,
    });
  });

  it("preserves an empty in-file range for memory_get corpus=all", async () => {
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
      from: params.from ?? 1,
      lines: 0,
    }));
    const getSupplement = vi.fn(async () => ({
      corpus: "wiki" as const,
      path: "memory/entities/alpha.md",
      title: "Alpha",
      kind: "entity",
      content: "Alpha wiki entry",
      fromLine: 10,
      lineCount: 5,
    }));
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: getSupplement,
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_empty_range", {
      path: "memory/entities/alpha.md",
      from: 10,
      lines: 5,
      corpus: "all",
    });

    expect(result.details).toEqual({
      text: "",
      path: "memory/entities/alpha.md",
      from: 10,
      lines: 0,
    });
    expect(getSupplement).not.toHaveBeenCalled();
  });

  it("returns the primary error when a corpus=all supplement fallback throws", async () => {
    setMemoryReadFileImpl(async () => {
      throw new Error("primary read failed");
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => {
        throw new Error("supplement lookup failed");
      },
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_supplement_throws", {
      path: "entities/alpha.md",
      corpus: "all",
    });

    expect(result.details).toEqual({
      path: "entities/alpha.md",
      text: "",
      disabled: true,
      error: "primary read failed",
    });
  });
});

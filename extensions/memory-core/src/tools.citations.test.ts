import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "../../../src/plugins/memory-state.js";
import {
  getMemorySearchManagerMockCalls,
  getReadAgentMemoryFileMockCalls,
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
  setMemoryWorkspaceDir,
  type MemoryReadParams,
} from "./memory-tool-manager-mock.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";
import {
  asOpenClawConfig,
  createAutoCitationsMemorySearchTool,
  createDefaultMemoryToolConfig,
  createMemoryGetToolOrThrow,
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

async function waitFor<T>(task: () => Promise<T>, timeoutMs: number = 1500): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Timed out waiting for async test condition");
}

beforeEach(() => {
  clearMemoryPluginState();
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
    readFileImpl: async (params: MemoryReadParams) => ({ text: "", path: params.relPath }),
  });
});

describe("memory search citations", () => {
  it("appends source information when citations are enabled", async () => {
    setMemoryBackend("builtin");
    const cfg = asOpenClawConfig({
      memory: { citations: "on" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_on", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    expect(details.results[0]?.snippet).toMatch(/Source: MEMORY.md#L5-L7/);
    expect(details.results[0]?.citation).toBe("MEMORY.md#L5-L7");
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
    expect(details.results[0]?.snippet).not.toMatch(/Source:/);
    expect(details.results[0]?.citation).toBeUndefined();
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
    expect(details.results[0]?.snippet.length).toBeLessThanOrEqual(20);
  });

  it("honors auto mode for direct chats", async () => {
    setMemoryBackend("builtin");
    const tool = createAutoCitationsMemorySearchTool("agent:main:discord:dm:u123");
    const result = await tool.execute("auto_mode_direct", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    expect(details.results[0]?.snippet).toMatch(/Source:/);
  });

  it("suppresses citations for auto mode in group chats", async () => {
    setMemoryBackend("builtin");
    const tool = createAutoCitationsMemorySearchTool("agent:main:discord:group:c123");
    const result = await tool.execute("auto_mode_group", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    expect(details.results[0]?.snippet).not.toMatch(/Source:/);
  });
});

describe("memory tools", () => {
  it("does not throw when memory_search fails (e.g. embeddings 429)", async () => {
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

  it("does not throw when memory_get fails", async () => {
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
      return { text: "", path: "memory/2026-02-19.md" };
    });

    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_enoent", { path: "memory/2026-02-19.md" });
    expect(result.details).toEqual({
      text: "",
      path: "memory/2026-02-19.md",
    });
  });

  it("uses the builtin direct memory file path for memory_get", async () => {
    setMemoryBackend("builtin");
    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_builtin_fast_path", { path: "memory/2026-02-19.md" });

    expect(result.details).toEqual({
      text: "",
      path: "memory/2026-02-19.md",
    });
    expect(getReadAgentMemoryFileMockCalls()).toBe(1);
    expect(getMemorySearchManagerMockCalls()).toBe(0);
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

      const tool = createMemorySearchToolOrThrow();
      await tool.execute("call_recall_persist", { query: "glacier backup" });

      const storePath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
      const storeRaw = await waitFor(async () => await fs.readFile(storePath, "utf-8"));
      const store = JSON.parse(storeRaw) as {
        entries?: Record<string, { path: string; recallCount: number }>;
      };
      const entries = Object.values(store.entries ?? {});
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        path: "memory/2026-04-03.md",
        recallCount: 1,
      });
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

    expect(result.details).toMatchObject({
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
    });
    expect(getMemorySearchManagerMockCalls()).toBe(0);
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
});

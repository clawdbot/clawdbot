import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
// Memory Core integration tests exercise the real SQLite search manager through tools.
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as generationLease from "./memory/manager-index-generation-lease.js";
import {
  createManagerIndexFixture,
  type ManagerIndexFixture,
} from "./memory/manager-index.test-support.js";
import { createMemorySearchTool, testing } from "./tools.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./memory/index.js");
const { MemoryIndexManager } = await import("./memory/manager.js");

describe("memory_search real manager", () => {
  const fixture: ManagerIndexFixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  beforeEach(() => {
    testing.resetMemorySearchToolCooldowns();
  });

  it("reports current invalid config after replacing the config of a retained tool", async () => {
    const cases = [
      {
        provider: "openai-compatible",
        fallback: "none",
        error:
          "memory.search.multimodal requires a provider adapter that supports multimodal embeddings for the configured model.",
      },
      {
        provider: "none",
        fallback: "gemini",
        error:
          'memory.search.multimodal does not support memory.search.fallback. Set fallback to "none".',
      },
    ] as const;
    let config = fixture.createConfig({});
    const tool = createMemorySearchTool({ getConfig: () => config, agentId: "main" });
    if (!tool) {
      throw new Error("memory_search tool missing");
    }

    for (const testCase of cases) {
      config = fixture.createConfig({
        provider: testCase.provider,
        fallback: testCase.fallback,
        multimodal: { enabled: true, modalities: ["image"] },
      });
      const result = await tool.execute("invalid-config", { query: "alpha" });

      expect(result.details).toMatchObject({
        results: [],
        disabled: true,
        unavailable: true,
        error: testCase.error,
        action: "Check embedding provider configuration and retry memory_search.",
      });
      expect(result.content).toContainEqual({
        type: "text",
        text: expect.stringContaining(
          "Check embedding provider configuration and retry memory_search.",
        ),
      });
      expect(fixture.provider.providerCalls).toEqual([]);
    }
  });

  it("attributes a persisted provenance mismatch to OpenClaw", async () => {
    const cfg = fixture.createConfig({
      provider: "none",
      vectorEnabled: false,
    });
    const manager = await fixture.getFreshManager(cfg);
    await manager.sync({ reason: "cli", force: true });
    await manager.close();
    await closeAllMemorySearchManagers();

    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const row = db
      .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
      .get() as { value: string };
    db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
      JSON.stringify({ ...JSON.parse(row.value), provenanceVersion: 0 }),
    );
    closeOpenClawAgentDatabasesForTest();

    const tool = createMemorySearchTool({ config: cfg, agentId: "main" });
    if (!tool) {
      throw new Error("memory_search tool missing");
    }
    const result = await tool.execute("provenance-mismatch", { query: "alpha" });

    expect(result.details).toMatchObject({
      disabled: true,
      unavailable: true,
      error: "index provenance classifier changed",
      warning:
        "Tell the user: memory search is paused because this OpenClaw version changed the memory index format (index provenance classifier changed); no configuration change is needed.",
      action:
        "Tell the user to run: openclaw memory status --index --agent main. Rebuilding uses keyword indexing only and does not call an embedding provider.",
    });
    expect(fixture.provider.embedQueryCalls).toBe(0);
  });

  it("preserves reindex guidance alongside wiki results after an embedding model change", async () => {
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ model: "old-embed", vectorEnabled: false }),
    );
    await manager.sync({ reason: "cli", force: true });
    await manager.close();
    const embeddingCalls = fixture.provider.embedBatchCalls;
    const wikiHit = {
      corpus: "wiki" as const,
      path: "entities/alpha.md",
      score: 1,
      snippet: "Alpha wiki entry",
    };
    registerMemoryCorpusSupplement("memory-guidance-fixture", {
      search: async () => [wikiHit],
      get: async () => null,
    });
    try {
      const tool = createMemorySearchTool({
        config: fixture.createConfig({
          model: "new-embed",
          vectorEnabled: false,
        }),
        agentId: "main",
      });
      if (!tool) {
        throw new Error("memory_search tool missing");
      }
      const action =
        "Tell the user to run: openclaw memory status --index --agent main. Rebuilding may call the configured embedding provider and can incur provider cost.";
      const primary = await tool.execute("paused-primary", { query: "alpha" });
      expect(primary.details).toMatchObject({
        disabled: true,
        unavailable: true,
        action,
      });

      const combined = await tool.execute("paused-with-wiki", { query: "alpha", corpus: "all" });
      expect(combined.details).toMatchObject({
        results: [wikiHit],
        corpora: [
          { corpus: "memory", outcome: "unavailable" },
          { corpus: "wiki", outcome: "ok" },
        ],
        warning: expect.stringContaining("Memory corpus unavailable"),
        action,
      });
      expect(combined.content).toContainEqual({
        type: "text",
        text: expect.stringContaining(action),
      });
      expect(combined.details).not.toHaveProperty("disabled");
      expect(combined.details).not.toHaveProperty("unavailable");
      expect(fixture.provider.embedBatchCalls).toBe(embeddingCalls);
      expect(fixture.provider.embedQueryCalls).toBe(0);
    } finally {
      clearMemoryPluginState();
    }
  });

  it("keeps routine transcript refresh silent during memory_search", async () => {
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["memory", "sessions"],
      sessionMemory: true,
      minScore: 0,
      vectorEnabled: false,
    });
    const sessionKey = "agent:main:telegram:direct:refresh-proof";
    await fixture.seedSessionTranscript({
      sessionId: "refresh-proof",
      sessionKey,
      messages: [
        {
          role: "user",
          content: "The transcript refresh marker is cobalt orchid.",
          timestamp: "2026-08-30T09:00:00.000Z",
        },
      ],
    });
    const manager = await fixture.getFreshManager(cfg);
    await manager.sync({ reason: "baseline", force: true });
    await fixture.seedSessionTranscript({
      sessionId: "refresh-proof",
      sessionKey,
      messages: [
        {
          role: "assistant",
          content: "A second transcript write is waiting for indexing.",
          timestamp: "2026-08-30T09:01:00.000Z",
        },
      ],
    });
    Reflect.set(manager, "sessionsDirty", true);

    const maintenanceReady = createDeferred<void>();
    const releaseMaintenance = createDeferred<void>();
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await originalGet(params);
      if (params.purpose !== "maintenance" || !acquired) {
        return acquired;
      }
      const fields = acquired as unknown as {
        syncArchiveFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
      };
      const syncArchiveFiles = fields.syncArchiveFiles.bind(acquired);
      vi.spyOn(fields, "syncArchiveFiles").mockImplementation(async (syncParams) => {
        const result = await syncArchiveFiles(syncParams);
        maintenanceReady.resolve();
        await releaseMaintenance.promise;
        return result;
      });
      return acquired;
    });

    try {
      const tool = createMemorySearchTool({
        config: cfg,
        agentId: "main",
        agentSessionKey: "agent:main:telegram:direct:active-refresh-proof",
      });
      if (!tool) {
        throw new Error("memory_search tool missing");
      }
      const execution = tool.execute("routine-refresh", {
        query: "zebra",
        corpus: "memory",
      });
      await maintenanceReady.promise;
      const result = await execution;

      expect(result.details).toMatchObject({
        results: [expect.objectContaining({ snippet: expect.stringContaining("Zebra") })],
      });
      expect(result.details).not.toHaveProperty("stale");
      expect(result.details).not.toHaveProperty("warning");
      expect(result.details).not.toHaveProperty("action");
    } finally {
      releaseMaintenance.resolve();
      getSpy.mockRestore();
    }
  });

  it("backfills visible sessions with one bounded query embedding", async () => {
    const baseConfig = fixture.createConfig({
      sources: ["sessions"],
      sessionMemory: true,
      minScore: 0,
      vectorEnabled: false,
    });
    const cfg = {
      ...baseConfig,
      memory: { ...baseConfig.memory, citations: "off" },
      tools: { ...baseConfig.tools, sessions: { visibility: "self" } },
    } satisfies OpenClawConfig;
    const anchorSessionKey = "agent:main:telegram:direct:owner";

    await fixture.seedSessionTranscript({
      sessionId: "current",
      sessionKey: anchorSessionKey,
      messages: [],
    });
    for (const [sessionId, sessionKey, content] of [
      ["hidden-a", "agent:main:discord:group:hidden-a", "alpha alpha alpha hidden group a"],
      ["hidden-b", "agent:main:discord:group:hidden-b", "alpha alpha alpha hidden group b"],
      ["visible-a", "agent:main:telegram:direct:visible-a", "alpha beta visible private a"],
      ["visible-b", "agent:main:telegram:direct:visible-b", "alpha beta visible private b"],
    ] as const) {
      await fixture.seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [{ role: "assistant", content, timestamp: "2026-08-17T12:00:00.000Z" }],
      });
    }

    const manager = await fixture.getFreshManager(cfg);
    await manager.sync({ reason: "test", force: true });
    expect(manager.status().sourceCounts).toEqual([{ source: "sessions", files: 5, chunks: 4 }]);

    const ranked = await manager.search("alpha", {
      maxResults: 4,
      minScore: 0,
      sources: ["sessions"],
    });
    expect(
      ranked
        .slice(0, 2)
        .map((hit) => hit.path)
        .toSorted(),
    ).toEqual([expect.stringContaining("hidden-a"), expect.stringContaining("hidden-b")]);
    fixture.provider.embedQueryCalls = 0;
    fixture.provider.embeddedQueryTexts = [];

    const tool = createMemorySearchTool({
      config: cfg,
      agentId: "main",
      agentSessionKey: `${anchorSessionKey}:active-memory:abcdef123456`,
      conversationRecall: {
        anchorSessionKey,
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });
    if (!tool) {
      throw new Error("memory_search tool missing");
    }

    const result = await tool.execute("real-manager-visible-backfill", {
      query: "alpha",
      corpus: "sessions",
      maxResults: 2,
    });
    const details = result.details as {
      results: Array<{ snippet: string }>;
      debug?: {
        hits: number;
        candidateHits: number;
        withheldHits: number;
        searchWindow: number;
      };
    };

    expect(details.results.map((hit) => hit.snippet).toSorted()).toEqual([
      expect.stringContaining("visible private a"),
      expect.stringContaining("visible private b"),
    ]);
    expect(fixture.provider.embedQueryCalls).toBe(1);
    expect(fixture.provider.embeddedQueryTexts).toEqual(["alpha"]);
    expect(details.debug).toMatchObject({
      hits: 2,
      candidateHits: 4,
      withheldHits: 2,
      searchWindow: 4,
    });
  });

  it("preserves canonical-session migration recovery through cooldown", async () => {
    const baseConfig = fixture.createConfig({
      provider: "none",
      sources: ["sessions"],
      sessionMemory: true,
      minScore: 0,
      vectorEnabled: false,
    });
    const cfg = {
      ...baseConfig,
      memory: { ...baseConfig.memory, citations: "off" },
    } satisfies OpenClawConfig;
    await fixture.seedSessionTranscript({
      sessionId: "recovery-source",
      sessionKey: "agent:main:telegram:direct:recovery-source",
      messages: [
        {
          role: "user",
          content: "Operator recovery instructions.",
          timestamp: "2026-09-03T00:00:00.000Z",
        },
      ],
    });
    const initializedManager = await fixture.getFreshManager(cfg);
    await initializedManager.sync({ reason: "test", force: true });
    await initializedManager.close();
    await closeAllMemorySearchManagers();

    openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "Agent:Main:Main",
        "legacy-session",
        JSON.stringify({ sessionId: "legacy-session", updatedAt: 1 }),
        1,
      );
    closeOpenClawAgentDatabasesForTest();

    const tool = createMemorySearchTool({
      config: cfg,
      agentId: "main",
      agentSessionKey: "agent:main:main",
    });
    if (!tool) {
      throw new Error("memory_search tool missing");
    }

    const first = await tool.execute("migration-first", { query: "operator recovery" });
    openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare("DELETE FROM session_nodes WHERE session_key = ?")
      .run("Agent:Main:Main");
    closeOpenClawAgentDatabasesForTest();
    const replay = await tool.execute("migration-replay", {
      query: "different anti-cheat query",
    });
    const expected = {
      unavailable: true,
      error: expect.stringContaining("openclaw doctor --fix"),
      warning:
        "Memory search is unavailable because the session catalog requires canonical-key migration.",
      action:
        "Stop the Gateway and run openclaw doctor --fix, then restart the Gateway and retry memory_search.",
    };

    expect(first.details).toMatchObject(expected);
    expect(replay.details).toMatchObject(expected);
    expect(fixture.provider.embedQueryCalls).toBe(0);
  });

  it("finishes one-shot cleanup when its deadline aborts a publication wait", async () => {
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["memory"],
      vectorEnabled: false,
      minScore: 0,
    });
    const initializedManager = await fixture.getFreshManager(cfg, "cli");
    await initializedManager.sync({ reason: "test", force: true });
    const databasePath = initializedManager.status().dbPath;
    if (!databasePath) {
      throw new Error("memory search manager database path missing");
    }
    await initializedManager.close();

    const publicationEntered = createDeferred<void>();
    const releasePublication = createDeferred<void>();
    const publication = generationLease.withMemoryIndexPublishGeneration(databasePath, async () => {
      publicationEntered.resolve();
      await releasePublication.promise;
    });
    await publicationEntered.promise;

    const tool = createMemorySearchTool({
      config: cfg,
      agentId: "main",
      oneShotCliRun: true,
    });
    if (!tool) {
      throw new Error("memory_search tool missing");
    }
    const searchStarted = createDeferred<void>();
    const originalGet = MemoryIndexManager.get.bind(MemoryIndexManager);
    const getSpy = vi.spyOn(MemoryIndexManager, "get").mockImplementation(async (params) => {
      const acquired = await originalGet(params);
      if (params.purpose !== "cli" || !acquired) {
        return acquired;
      }
      const search = acquired.search.bind(acquired);
      vi.spyOn(acquired, "search").mockImplementation(async (...args) => {
        searchStarted.resolve();
        return await search(...args);
      });
      return acquired;
    });
    vi.useFakeTimers();
    let executionSettled = false;
    const execution = tool.execute("timed-out-generation-wait", { query: "zebra" }).finally(() => {
      executionSettled = true;
    });
    try {
      await searchStarted.promise;
      await vi.advanceTimersByTimeAsync(15_100);
      expect(executionSettled).toBe(true);
      await expect(execution).resolves.toMatchObject({
        details: { unavailable: true },
      });
    } finally {
      releasePublication.resolve();
      await vi.advanceTimersByTimeAsync(100);
      await publication;
      await execution.catch(() => undefined);
      getSpy.mockRestore();
    }
  });
});

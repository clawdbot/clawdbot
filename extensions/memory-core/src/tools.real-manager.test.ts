import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
// Memory Core integration tests exercise the real SQLite search manager through tools.
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
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
    expect(ranked.slice(0, 2).map((hit) => hit.path)).toEqual([
      expect.stringContaining("hidden-a"),
      expect.stringContaining("hidden-b"),
    ]);
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

    expect(details.results.map((hit) => hit.snippet)).toEqual([
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
      sources: ["sessions"],
      sessionMemory: true,
      minScore: 0,
      vectorEnabled: false,
    });
    const cfg = {
      ...baseConfig,
      memory: { ...baseConfig.memory, citations: "off" },
    } satisfies OpenClawConfig;
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
      onSearch: false,
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

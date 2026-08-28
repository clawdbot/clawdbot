// Memory Core integration tests exercise the real SQLite search manager through tools.
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { describe, expect, it } from "vitest";
import {
  createManagerIndexFixture,
  type ManagerIndexFixture,
} from "./memory/manager-index.test-support.js";
import { createMemorySearchTool } from "./tools.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./memory/index.js");

describe("memory_search real manager", () => {
  const fixture: ManagerIndexFixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
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
});

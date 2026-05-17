import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import * as sessionTranscriptHit from "openclaw/plugin-sdk/session-transcript-hit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

type TestSessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile: string;
};

const crossAgentStore: Record<string, TestSessionEntry> = {
  "agent:peer:only": {
    sessionId: "w1",
    updatedAt: 1,
    sessionFile: "/tmp/sessions/w1.jsonl",
  },
};
let combinedSessionStore: Record<string, TestSessionEntry> = crossAgentStore;

vi.mock("openclaw/plugin-sdk/session-transcript-hit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-hit")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({
      storePath: "(test)",
      store: combinedSessionStore,
    })),
  };
});

describe("filterMemorySearchHitsBySessionVisibility", () => {
  afterEach(() => {
    vi.mocked(sessionTranscriptHit.loadCombinedSessionStoreForGateway).mockClear();
    combinedSessionStore = crossAgentStore;
  });

  it("drops sessions-sourced hits when requester key is missing (fail closed)", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      {
        path: "sessions/u1.jsonl",
        source: "sessions",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
    ];
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: undefined,
      sandboxed: false,
      hits,
    });
    expect(filtered).toStrictEqual([]);
  });

  it("keeps non-session hits unchanged", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      {
        path: "memory/foo.md",
        source: "memory",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
    ];
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits,
    });
    expect(filtered).toEqual(hits);
  });

  it("loads the combined session store once per filter pass", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      {
        path: "sessions/w1.jsonl",
        source: "sessions",
        score: 1,
        snippet: "a",
        startLine: 1,
        endLine: 2,
      },
      {
        path: "sessions/w1.jsonl",
        source: "sessions",
        score: 0.9,
        snippet: "b",
        startLine: 1,
        endLine: 2,
      },
    ];
    await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits,
    });
    expect(sessionTranscriptHit.loadCombinedSessionStoreForGateway).toHaveBeenCalledTimes(1);
    expect(sessionTranscriptHit.loadCombinedSessionStoreForGateway).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
  });

  it("keeps same-agent session hits when visibility=all and agent-to-agent is enabled", async () => {
    combinedSessionStore = {
      "agent:main:only": {
        sessionId: "w1",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/w1.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/w1.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toEqual([hit]);
  });

  it("keeps global-scope session hits for non-default agents", async () => {
    combinedSessionStore = {
      global: {
        sessionId: "w1",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/w1.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/w1.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      session: { scope: "global" },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      agentId: "secondary",
      requesterSessionKey: "agent:secondary:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toEqual([hit]);
  });

  it("does not keep cross-agent session hits outside the scoped store", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "sessions/w1.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toStrictEqual([]);
  });

  it("does not keep cross-agent session hits when a shared store returns out-of-scope keys", async () => {
    combinedSessionStore = crossAgentStore;
    const hit: MemorySearchResult = {
      path: "sessions/w1.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toStrictEqual([]);
  });

  it("does not keep owner-qualified cross-agent hits that collide with a scoped stem", async () => {
    combinedSessionStore = {
      "agent:main:main": {
        sessionId: "main",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/main.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/peer/main.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toStrictEqual([]);
  });

  it("denies cross-agent session hits when agent-to-agent is disabled", async () => {
    const hit: MemorySearchResult = {
      path: "sessions/w1.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: false },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toStrictEqual([]);
  });

  it("keeps same-agent deleted archive hits using owner metadata when the live store entry is gone", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "sessions/main/deleted-stem.jsonl.deleted.2026-02-16T22-27-33.000Z",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "agent" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });

  it("still denies cross-agent deleted archive hits resolved from owner metadata when a2a is disabled", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "sessions/peer/deleted-stem.jsonl.deleted.2026-02-16T22-27-33.000Z",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: false },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toStrictEqual([]);
  });

  it("does not keep cross-agent deleted archive hits outside the scoped store when a2a is allowed", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "sessions/peer/deleted-stem.jsonl.deleted.2026-02-16T22-27-33.000Z",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toStrictEqual([]);
  });
});

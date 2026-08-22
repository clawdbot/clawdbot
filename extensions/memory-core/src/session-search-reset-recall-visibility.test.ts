import * as engineSessions from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import * as sessionTranscriptHit from "openclaw/plugin-sdk/session-transcript-hit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

type TestSessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile: string;
  chatType?: "direct" | "group" | "channel";
};

let combinedSessionStore: Record<string, TestSessionEntry> = {};

function entryWithCutoff(cutoff: unknown) {
  const entry = {};
  Object.defineProperty(entry, Symbol.for("openclaw.memory.sessionResetRecallCutoff"), {
    enumerable: false,
    value: cutoff,
  });
  return entry;
}

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-sessions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-sessions")>();
  return {
    ...actual,
    buildSessionEntry: vi.fn(async () => entryWithCutoff({ state: "absent" })),
  };
});

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

describe("reset-generation session search visibility", () => {
  afterEach(() => {
    vi.mocked(sessionTranscriptHit.loadCombinedSessionStoreForGateway).mockClear();
    vi.mocked(engineSessions.buildSessionEntry).mockReset();
    vi.mocked(engineSessions.buildSessionEntry).mockResolvedValue(
      entryWithCutoff({ state: "absent" }) as never,
    );
    combinedSessionStore = {};
  });

  it.each([
    { name: "pre-reset", range: [2, 3], cutoff: { state: "valid", cutoffLine: 4 }, kept: true },
    { name: "crossing", range: [3, 4], cutoff: { state: "valid", cutoffLine: 4 }, kept: false },
    { name: "current", range: [4, 5], cutoff: { state: "valid", cutoffLine: 4 }, kept: false },
    { name: "missing", range: [1, 2], cutoff: { state: "absent" }, kept: false },
    { name: "missing-contract", range: [1, 2], cutoff: undefined, kept: false },
    { name: "malformed", range: [1, 2], cutoff: { state: "invalid" }, kept: false },
  ] as const)(
    "handles a $name live SQLite reset-generation hit",
    async ({ range, cutoff, kept }) => {
      const anchorSessionKey = "agent:main:telegram:direct:owner";
      combinedSessionStore = {
        [anchorSessionKey]: {
          sessionId: "current",
          updatedAt: 2,
          sessionFile: "/tmp/sessions/current.jsonl",
          chatType: "direct",
        },
      };
      vi.mocked(engineSessions.buildSessionEntry).mockResolvedValue(
        (cutoff === undefined ? {} : entryWithCutoff(cutoff)) as never,
      );
      const hit: MemorySearchResult = {
        path: "sessions/main/current.jsonl",
        source: "sessions",
        score: 1,
        snippet: "short fact",
        startLine: range[0],
        endLine: range[1],
      };

      const filtered = await filterMemorySearchHitsBySessionVisibility({
        cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
        agentId: "main",
        requesterSessionKey: `${anchorSessionKey}:active-memory:123456abcdef`,
        sandboxed: false,
        hits: [hit],
        conversationRecall: { anchorSessionKey, scope: "same-agent-private", corpus: "sessions" },
      });

      expect(filtered).toEqual(kept ? [hit] : []);
    },
  );

  it("resolves the live anchor reset cutoff once per filter pass", async () => {
    const anchorSessionKey = "agent:main:telegram:direct:owner";
    combinedSessionStore = {
      [anchorSessionKey]: {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
    };
    vi.mocked(engineSessions.buildSessionEntry).mockResolvedValue(
      entryWithCutoff({ state: "valid", cutoffLine: 5 }) as never,
    );
    const hits: MemorySearchResult[] = [
      {
        path: "sessions/main/current.jsonl",
        source: "sessions",
        score: 1,
        snippet: "first pre-reset chunk",
        startLine: 1,
        endLine: 2,
      },
      {
        path: "sessions/main/current.jsonl",
        source: "sessions",
        score: 0.9,
        snippet: "second pre-reset chunk",
        startLine: 3,
        endLine: 4,
      },
    ];

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
      agentId: "main",
      requesterSessionKey: `${anchorSessionKey}:active-memory:123456abcdef`,
      sandboxed: false,
      hits,
      conversationRecall: { anchorSessionKey, scope: "same-agent-private", corpus: "sessions" },
    });

    expect(filtered).toEqual(hits);
    expect(engineSessions.buildSessionEntry).toHaveBeenCalledTimes(1);
    expect(engineSessions.buildSessionEntry).toHaveBeenCalledWith("current.jsonl", {
      agentId: "main",
      sessionId: "current",
      sessionKey: anchorSessionKey,
      storePath: "(test)",
      updatedAtMs: 2,
    });
  });

  it.each(["", ".zst"])(
    "allows an archived reset generation of the private anchor conversation%s",
    async (compressionSuffix) => {
      const anchorSessionKey = "agent:main:telegram:direct:owner";
      combinedSessionStore = {
        [anchorSessionKey]: {
          sessionId: "current",
          updatedAt: 2,
          sessionFile: "/tmp/sessions/current.jsonl",
          chatType: "direct",
        },
      };
      const hit: MemorySearchResult = {
        path: `sessions/main/current.jsonl.reset.2026-08-11T08-00-00.000Z${compressionSuffix}`,
        source: "sessions",
        score: 1,
        snippet: "prior conversation context",
        startLine: 1,
        endLine: 2,
      };

      const filtered = await filterMemorySearchHitsBySessionVisibility({
        cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
        agentId: "main",
        requesterSessionKey: `${anchorSessionKey}:active-memory:123456abcdef`,
        sandboxed: false,
        hits: [hit],
        conversationRecall: { anchorSessionKey, scope: "same-agent-private", corpus: "sessions" },
      });

      expect(filtered).toEqual([hit]);
    },
  );

  it.each([
    {
      name: "the private anchor conversation",
      path: "sessions/main/current.jsonl.deleted.2026-08-11T08-00-00.000Z",
      snippet: "explicitly deleted private context",
      includeDeletedSource: false,
    },
    {
      name: "the compressed private anchor conversation",
      path: "sessions/main/current.jsonl.deleted.2026-08-11T08-00-00.000Z.zst",
      snippet: "explicitly deleted compressed private context",
      includeDeletedSource: false,
    },
    {
      name: "another private conversation",
      path: "sessions/main/deleted-source.jsonl.deleted.2026-08-11T08-00-00.000Z",
      snippet: "intentionally deleted private context",
      includeDeletedSource: true,
    },
    {
      name: "another compressed private conversation",
      path: "sessions/main/deleted-source.jsonl.deleted.2026-08-11T08-00-00.000Z.zst",
      snippet: "intentionally deleted compressed private context",
      includeDeletedSource: true,
    },
  ])(
    "denies an archived deleted generation from $name",
    async ({ path, snippet, includeDeletedSource }) => {
      const anchorSessionKey = "agent:main:telegram:direct:owner";
      combinedSessionStore = {
        [anchorSessionKey]: {
          sessionId: "current",
          updatedAt: 2,
          sessionFile: "/tmp/sessions/current.jsonl",
          chatType: "direct",
        },
        ...(includeDeletedSource
          ? {
              "agent:main:telegram:direct:deleted-source": {
                sessionId: "deleted-source",
                updatedAt: 1,
                sessionFile: "/tmp/sessions/deleted-source.jsonl",
                chatType: "direct" as const,
              },
            }
          : {}),
      };
      const hit: MemorySearchResult = {
        path,
        source: "sessions",
        score: 1,
        snippet,
        startLine: 1,
        endLine: 2,
      };

      const filtered = await filterMemorySearchHitsBySessionVisibility({
        cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
        agentId: "main",
        requesterSessionKey: `${anchorSessionKey}:active-memory:123456abcdef`,
        sandboxed: false,
        hits: [hit],
        conversationRecall: { anchorSessionKey, scope: "same-agent-private", corpus: "sessions" },
      });

      expect(filtered).toEqual([]);
    },
  );
});

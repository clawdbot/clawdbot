import * as engineSessions from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import * as sessionTranscriptHit from "openclaw/plugin-sdk/session-transcript-hit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import {
  searchHit,
  sessionEntry,
  type TestSessionEntry,
} from "./session-search-visibility.test-support.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

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
    loadArchivedSessions: vi.fn(() => []),
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
    vi.mocked(engineSessions.loadArchivedSessions).mockReset();
    vi.mocked(engineSessions.loadArchivedSessions).mockReturnValue([]);
    combinedSessionStore = {};
  });

  it("resolves bounded archive filenames through canonical SQLite identity", async () => {
    const archivedSessionId = `oversized-${"x".repeat(300)}`;
    const sessionKey = "agent:main:telegram:direct:owner";
    const archiveName = `session-${"a".repeat(64)}.jsonl.reset.2026-08-11T08-00-00.000Z.zst`;
    combinedSessionStore = {
      [sessionKey]: sessionEntry(
        "current-after-reset",
        2,
        "/tmp/sessions/current-after-reset.jsonl",
        { chatType: "direct" },
      ),
    };
    vi.mocked(engineSessions.loadArchivedSessions).mockReturnValue([
      { archiveName, sessionId: archivedSessionId, sessionKey, createdAt: 1 },
    ]);
    const hit: MemorySearchResult = searchHit(
      `sessions/main/${archiveName}`,
      "sessions",
      "retained context",
    );

    await expect(
      filterMemorySearchHitsBySessionVisibility({
        cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
        agentId: "main",
        requesterSessionKey: sessionKey,
        sandboxed: false,
        hits: [hit],
      }),
    ).resolves.toEqual([hit]);
    expect(engineSessions.loadArchivedSessions).toHaveBeenCalledWith({
      agentId: "main",
      archiveNames: [archiveName],
      storePath: "(test)",
    });
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
        [anchorSessionKey]: sessionEntry("current", 2, "/tmp/sessions/current.jsonl", {
          chatType: "direct",
        }),
      };
      vi.mocked(engineSessions.buildSessionEntry).mockResolvedValue(
        (cutoff === undefined ? {} : entryWithCutoff(cutoff)) as never,
      );
      const hit: MemorySearchResult = searchHit(
        "sessions/main/current.jsonl",
        "sessions",
        "short fact",
        { startLine: range[0], endLine: range[1] },
      );

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
      [anchorSessionKey]: sessionEntry("current", 2, "/tmp/sessions/current.jsonl", {
        chatType: "direct",
      }),
    };
    vi.mocked(engineSessions.buildSessionEntry).mockResolvedValue(
      entryWithCutoff({ state: "valid", cutoffLine: 5 }) as never,
    );
    const hits: MemorySearchResult[] = [
      searchHit("sessions/main/current.jsonl", "sessions", "first pre-reset chunk"),
      searchHit("sessions/main/current.jsonl", "sessions", "second pre-reset chunk", {
        score: 0.9,
        startLine: 3,
        endLine: 4,
      }),
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
        [anchorSessionKey]: sessionEntry("current", 2, "/tmp/sessions/current.jsonl", {
          chatType: "direct",
        }),
      };
      const hit: MemorySearchResult = searchHit(
        `sessions/main/current.jsonl.reset.2026-08-11T08-00-00.000Z${compressionSuffix}`,
        "sessions",
        "prior conversation context",
      );

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
        [anchorSessionKey]: sessionEntry("current", 2, "/tmp/sessions/current.jsonl", {
          chatType: "direct",
        }),
        ...(includeDeletedSource
          ? {
              "agent:main:telegram:direct:deleted-source": sessionEntry(
                "deleted-source",
                1,
                "/tmp/sessions/deleted-source.jsonl",
                { chatType: "direct" as const },
              ),
            }
          : {}),
      };
      const hit: MemorySearchResult = searchHit(path, "sessions", snippet);

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

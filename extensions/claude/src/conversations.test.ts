import { describe, expect, it } from "vitest";
import type { ClaudeBindingSessionIdentity } from "./app-server/thread-store.js";
import { createClaudeTestBindingStore } from "./app-server/thread-store.test-helpers.js";
import {
  buildConversationRows,
  type ConversationSessionEntry,
  formatConversationsList,
  isConversationSessionKey,
  isExcludedByCustomFilter,
  resolveConversationsExcludePatterns,
} from "./command-handlers.js";

describe("isConversationSessionKey", () => {
  it("treats direct and channel sessions as real conversations", () => {
    expect(isConversationSessionKey("agent:tank:direct:eddie")).toBe(true);
    expect(isConversationSessionKey("agent:tank:discord:channel:12345")).toBe(true);
    expect(isConversationSessionKey("agent:main:slack:channel:c0b2eddpw95")).toBe(true);
  });

  it("excludes subagent, cron, and heartbeat sessions", () => {
    expect(isConversationSessionKey("agent:tank:subagent:9b13027d-...")).toBe(false);
    expect(isConversationSessionKey("agent:tank:cron:82c35b10-...")).toBe(false);
    expect(isConversationSessionKey("agent:tank:slack:channel:c0b2eddpw95:heartbeat")).toBe(false);
  });
});

describe("buildConversationRows", () => {
  it("skips entries with no sessionId or that aren't real conversations, but counts real-key candidates even without a binding", async () => {
    const entries: ConversationSessionEntry[] = [
      { sessionKey: "agent:tank:direct:eddie", entry: {} }, // no sessionId
      {
        sessionKey: "agent:tank:direct:someone",
        entry: { sessionId: "s1" }, // real key, no binding (readBinding returns null below)
      },
      {
        sessionKey: "agent:tank:subagent:xyz",
        entry: { sessionId: "s2" }, // automation key, excluded regardless of sessionId
      },
    ];
    const { rows, candidateCount } = await buildConversationRows(entries, {
      readBinding: async () => null,
    });
    expect(rows).toHaveLength(0);
    // Only "someone" is a real-key candidate with a sessionId; "eddie" lacks a
    // sessionId and "xyz" is filtered by key before ever counting.
    expect(candidateCount).toBe(1);
  });

  it("resolves a binding for a qualifying entry via the injected deps, regardless of cliSessionBindings", async () => {
    const binding = {
      schemaVersion: 1,
      threadId: "thr_abc",
      cwd: "/tmp",
      createdAt: 1,
      updatedAt: 2,
    };
    const entries: ConversationSessionEntry[] = [
      {
        sessionKey: "agent:tank:direct:eddie",
        entry: { sessionId: "s1", origin: { label: "eddie" } },
      },
    ];
    const { rows, candidateCount } = await buildConversationRows(entries, {
      readBinding: async (identity) =>
        identity.sessionKey === "agent:tank:direct:eddie" && identity.sessionId === "s1"
          ? binding
          : null,
    });
    expect(candidateCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("eddie");
    expect(rows[0]?.binding.threadId).toBe("thr_abc");
  });

  it("finds a real conversation whose binding predates any core-session-store provider marker (the real bug this fixed)", async () => {
    // Confirmed against real production data: a session last touched
    // 2026-06-29 had a real, readable binding but no
    // cliSessionBindings/cliSessionIds entry on its core session record at
    // all (that marker is only written by openclaw-pg9-era turns). Gating on
    // the marker silently hid it from /claude conversations.
    const binding = {
      schemaVersion: 1,
      threadId: "thr_predates_marker",
      cwd: "/tmp",
      createdAt: 1,
      updatedAt: 2,
    };
    const entries: ConversationSessionEntry[] = [
      {
        sessionKey: "agent:tank:discord:tank:direct:159471966640799744",
        entry: { sessionId: "old-session-id" }, // no cliSessionBindings/cliSessionIds at all
      },
    ];
    const { rows } = await buildConversationRows(entries, {
      readBinding: async (identity) => (identity.sessionId === "old-session-id" ? binding : null),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.binding.threadId).toBe("thr_predates_marker");
  });

  it("skips a candidate entry when no binding exists yet", async () => {
    const entries: ConversationSessionEntry[] = [
      { sessionKey: "agent:tank:direct:eddie", entry: { sessionId: "s1" } },
    ];
    const { rows, candidateCount } = await buildConversationRows(entries, {
      readBinding: async () => null,
    });
    expect(candidateCount).toBe(1);
    expect(rows).toHaveLength(0);
  });
});

describe("formatConversationsList", () => {
  it("reports no-candidates vs no-bindings-yet distinctly when empty", () => {
    expect(formatConversationsList([], 0)).toContain("No other real conversation sessions found");
    expect(formatConversationsList([], 3)).toContain("none have a bound Claude thread yet");
  });

  it("sorts by updatedAt descending and renders summary fields", () => {
    const rows = [
      {
        label: "older",
        sessionKey: "agent:tank:direct:a",
        binding: {
          schemaVersion: 1,
          threadId: "thr_old",
          cwd: "/tmp",
          model: "claude-sonnet-5",
          modelProvider: "anthropic",
          createdAt: 1,
          updatedAt: 1000,
          turnCount: 2,
          lastAssistantPreview: "an old reply",
        },
      },
      {
        label: "newer",
        sessionKey: "agent:tank:direct:b",
        binding: {
          schemaVersion: 1,
          threadId: "thr_new",
          cwd: "/tmp",
          model: "glm-5.2",
          modelProvider: "zai",
          createdAt: 1,
          updatedAt: 2000,
          turnCount: 5,
          lastAssistantPreview: "a newer reply",
        },
      },
    ];
    const text = formatConversationsList(rows, 2);
    const newerIdx = text.indexOf("newer");
    const olderIdx = text.indexOf("older");
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThan(newerIdx);
    expect(text).toContain("thr_new");
    expect(text).toContain("glm-5.2 (zai)");
    expect(text).toContain("a newer reply");
    expect(text).toContain("Turns: 5");
  });

  it("notes how many rows were truncated beyond the display limit", () => {
    const rows = Array.from({ length: 17 }, (_, i) => ({
      label: `conv-${i}`,
      sessionKey: `agent:tank:direct:${i}`,
      binding: {
        schemaVersion: 1,
        threadId: `thr_${i}`,
        cwd: "/tmp",
        createdAt: 1,
        updatedAt: i,
      },
    }));
    const text = formatConversationsList(rows, 17);
    expect(text).toContain("Showing 15 of 17");
    expect(text).toContain("2 more not shown");
  });
});

describe("resolveConversationsExcludePatterns", () => {
  it("reads a valid string array off the plugin config", () => {
    const patterns = resolveConversationsExcludePatterns({
      conversations: { excludePatterns: ["cio-agent-heartbeats", "standup"] },
    });
    expect(patterns).toEqual(["cio-agent-heartbeats", "standup"]);
  });

  it("drops non-string and blank entries", () => {
    const patterns = resolveConversationsExcludePatterns({
      conversations: { excludePatterns: ["real", "", "  ", 42, null, "also-real"] },
    });
    expect(patterns).toEqual(["real", "also-real"]);
  });

  it("returns an empty array for absent, malformed, or non-object config", () => {
    expect(resolveConversationsExcludePatterns(undefined)).toEqual([]);
    expect(resolveConversationsExcludePatterns({})).toEqual([]);
    expect(resolveConversationsExcludePatterns({ conversations: {} })).toEqual([]);
    expect(
      resolveConversationsExcludePatterns({ conversations: { excludePatterns: "not-an-array" } }),
    ).toEqual([]);
    expect(resolveConversationsExcludePatterns("garbage")).toEqual([]);
  });
});

describe("isExcludedByCustomFilter", () => {
  it("matches case-insensitively against the session key", () => {
    const row = {
      sessionKey: "agent:tank:slack:channel:c0b2eddpw95:thread:123",
      label: "some-thread",
    };
    expect(isExcludedByCustomFilter(row, ["C0B2EDDPW95"])).toBe(true);
  });

  it("matches case-insensitively against the display label", () => {
    const row = {
      sessionKey: "agent:tank:slack:channel:c0b2eddpw95:thread:123",
      label: "#CIO-Agent-Heartbeats",
    };
    expect(isExcludedByCustomFilter(row, ["cio-agent-heartbeats"])).toBe(true);
  });

  it("does not exclude when no pattern matches", () => {
    const row = { sessionKey: "agent:tank:direct:eddie", label: "Eddie Abrams" };
    expect(isExcludedByCustomFilter(row, ["cio-agent-heartbeats", "standup"])).toBe(false);
  });

  it("never excludes anything when no patterns are configured", () => {
    const row = {
      sessionKey: "agent:tank:slack:channel:cio-agent-heartbeats:thread:1",
      label: "anything",
    };
    expect(isExcludedByCustomFilter(row, [])).toBe(false);
  });
});

describe("custom filter composed with buildConversationRows (the real /claude conversations pipeline)", () => {
  it("hides a matching conversation while keeping others visible", async () => {
    const heartbeatBinding = {
      schemaVersion: 1,
      threadId: "thr_heartbeat",
      cwd: "/tmp",
      createdAt: 1,
      updatedAt: 2,
    };
    const realBinding = {
      schemaVersion: 1,
      threadId: "thr_real",
      cwd: "/tmp",
      createdAt: 1,
      updatedAt: 3,
    };
    const entries: ConversationSessionEntry[] = [
      {
        sessionKey: "agent:tank:slack:channel:c0b2eddpw95:thread:1782258999.399789",
        entry: { sessionId: "heartbeat-session", origin: { label: "#cio-agent-heartbeats" } },
      },
      {
        sessionKey: "agent:tank:direct:eddie",
        entry: { sessionId: "real-session", origin: { label: "Eddie Abrams" } },
      },
    ];
    const bindingsBySessionId: Record<string, typeof heartbeatBinding> = {
      "heartbeat-session": heartbeatBinding,
      "real-session": realBinding,
    };
    const { rows } = await buildConversationRows(entries, {
      readBinding: async (identity: ClaudeBindingSessionIdentity) =>
        (identity.sessionId && bindingsBySessionId[identity.sessionId]) || null,
    });
    expect(rows).toHaveLength(2);

    const excludePatterns = resolveConversationsExcludePatterns({
      conversations: { excludePatterns: ["cio-agent-heartbeats"] },
    });
    const visibleRows = rows.filter((row) => !isExcludedByCustomFilter(row, excludePatterns));
    expect(visibleRows).toHaveLength(1);
    expect(visibleRows[0]?.label).toBe("Eddie Abrams");

    const text = formatConversationsList(visibleRows, rows.length);
    expect(text).not.toContain("cio-agent-heartbeats");
    expect(text).toContain("Eddie Abrams");
  });
});

describe("handleConversations end-to-end against a real binding store", () => {
  it("readBinding + buildConversationRows round-trip a binding written via the store", async () => {
    const store = createClaudeTestBindingStore();
    const identity = { sessionKey: "agent:tank:direct:eddie", sessionId: "real-session-id" };
    await store.write(identity, {
      threadId: "thr_real",
      cwd: "/tmp",
      model: "claude-sonnet-5",
      modelProvider: "anthropic",
    });
    await store.recordTurnSummary(identity, {
      stopReason: "stop",
      assistantPreview: "hi from a real binding",
    });
    const entries: ConversationSessionEntry[] = [
      {
        sessionKey: "agent:tank:direct:eddie",
        entry: {
          sessionId: "real-session-id",
          origin: { label: "eddie (real)" },
        },
      },
    ];
    const { rows, candidateCount } = await buildConversationRows(entries, {
      readBinding: (id) => store.read(id),
    });
    expect(candidateCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.binding.lastAssistantPreview).toBe("hi from a real binding");
    const text = formatConversationsList(rows, candidateCount);
    expect(text).toContain("eddie (real)");
    expect(text).toContain("hi from a real binding");
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR } from "../../agents/pi-settings.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  appendHistoryEntry,
  buildHistoryContext,
  buildHistoryContextFromEntries,
  buildHistoryContextFromMap,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  HISTORY_CONTEXT_MARKER,
  recordPendingHistoryEntryIfEnabled,
} from "./history.js";
import {
  DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
  hasAlreadyFlushedForCurrentCompaction,
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./memory-flush.js";
import { CURRENT_MESSAGE_MARKER } from "./mentions.js";
import { incrementCompactionCount } from "./session-updates.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function seedSessionStore(params: {
  storePath: string;
  sessionKey: string;
  entry: Record<string, unknown>;
}) {
  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  await fs.writeFile(
    params.storePath,
    JSON.stringify({ [params.sessionKey]: params.entry }, null, 2),
    "utf-8",
  );
}

async function createCompactionSessionFixture(entry: SessionEntry) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-"));
  tempDirs.push(tmp);
  const storePath = path.join(tmp, "sessions.json");
  const sessionKey = "main";
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
  await seedSessionStore({ storePath, sessionKey, entry });
  return { storePath, sessionKey, sessionStore };
}

describe("history helpers", () => {
  function createHistoryMapWithTwoEntries() {
    const historyMap = new Map<string, { sender: string; body: string }[]>();
    historyMap.set("group", [
      { sender: "A", body: "one" },
      { sender: "B", body: "two" },
    ]);
    return historyMap;
  }

  it("returns current message when history is empty", () => {
    const result = buildHistoryContext({
      historyText: "  ",
      currentMessage: "hello",
    });
    expect(result).toBe("hello");
  });

  it("wraps history entries and excludes current by default", () => {
    const result = buildHistoryContextFromEntries({
      entries: [
        { sender: "A", body: "one" },
        { sender: "B", body: "two" },
      ],
      currentMessage: "current",
      formatEntry: (entry) => `${entry.sender}: ${entry.body}`,
    });

    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain("A: one");
    expect(result).not.toContain("B: two");
    expect(result).toContain(CURRENT_MESSAGE_MARKER);
    expect(result).toContain("current");
  });

  it("trims history to configured limit", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    appendHistoryEntry({
      historyMap,
      historyKey: "group",
      limit: 2,
      entry: { sender: "A", body: "one" },
    });
    appendHistoryEntry({
      historyMap,
      historyKey: "group",
      limit: 2,
      entry: { sender: "B", body: "two" },
    });
    appendHistoryEntry({
      historyMap,
      historyKey: "group",
      limit: 2,
      entry: { sender: "C", body: "three" },
    });

    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["two", "three"]);
  });

  it("builds context from map and appends entry", () => {
    const historyMap = createHistoryMapWithTwoEntries();

    const result = buildHistoryContextFromMap({
      historyMap,
      historyKey: "group",
      limit: 3,
      entry: { sender: "C", body: "three" },
      currentMessage: "current",
      formatEntry: (entry) => `${entry.sender}: ${entry.body}`,
    });

    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["one", "two", "three"]);
    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain("A: one");
    expect(result).toContain("B: two");
    expect(result).not.toContain("C: three");
  });

  it("builds context from pending map without appending", () => {
    const historyMap = createHistoryMapWithTwoEntries();

    const result = buildPendingHistoryContextFromMap({
      historyMap,
      historyKey: "group",
      limit: 3,
      currentMessage: "current",
      formatEntry: (entry) => `${entry.sender}: ${entry.body}`,
    });

    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["one", "two"]);
    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain("A: one");
    expect(result).toContain("B: two");
    expect(result).toContain(CURRENT_MESSAGE_MARKER);
    expect(result).toContain("current");
  });

  it("records pending entries only when enabled", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    recordPendingHistoryEntryIfEnabled({
      historyMap,
      historyKey: "group",
      limit: 0,
      entry: { sender: "A", body: "one" },
    });
    expect(historyMap.get("group")).toEqual(undefined);

    recordPendingHistoryEntryIfEnabled({
      historyMap,
      historyKey: "group",
      limit: 2,
      entry: null,
    });
    expect(historyMap.get("group")).toEqual(undefined);

    recordPendingHistoryEntryIfEnabled({
      historyMap,
      historyKey: "group",
      limit: 2,
      entry: { sender: "B", body: "two" },
    });
    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["two"]);
  });

  it("clears history entries only when enabled", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();
    historyMap.set("group", [
      { sender: "A", body: "one" },
      { sender: "B", body: "two" },
    ]);

    clearHistoryEntriesIfEnabled({ historyMap, historyKey: "group", limit: 0 });
    expect(historyMap.get("group")?.map((entry) => entry.body)).toEqual(["one", "two"]);

    clearHistoryEntriesIfEnabled({ historyMap, historyKey: "group", limit: 2 });
    expect(historyMap.get("group")).toEqual([]);
  });
});

describe("memory flush settings", () => {
  it("defaults to enabled with fallback prompt and system prompt", () => {
    const settings = resolveMemoryFlushSettings();
    expect(settings).not.toBeNull();
    expect(settings?.enabled).toBe(true);
    expect(settings?.forceFlushTranscriptBytes).toBe(DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES);
    expect(settings?.prompt.length).toBeGreaterThan(0);
    expect(settings?.systemPrompt.length).toBeGreaterThan(0);
    expect(settings?.prompt).toContain("memory/YYYY-MM-DD.md");
    expect(settings?.prompt).toContain("MEMORY.md");
    expect(settings?.systemPrompt).toContain("memory/YYYY-MM-DD.md");
    expect(settings?.systemPrompt).toContain("MEMORY.md");
  });

  it("respects disable flag", () => {
    expect(
      resolveMemoryFlushSettings({
        agents: {
          defaults: { compaction: { memoryFlush: { enabled: false } } },
        },
      }),
    ).toBeNull();
  });

  it("appends NO_REPLY hint when missing", () => {
    const settings = resolveMemoryFlushSettings({
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              prompt: "Write memories now.",
              systemPrompt: "Flush memory.",
            },
          },
        },
      },
    });
    expect(settings?.prompt).toContain("NO_REPLY");
    expect(settings?.systemPrompt).toContain("NO_REPLY");
    expect(settings?.prompt).toContain("memory/YYYY-MM-DD.md");
    expect(settings?.prompt).toContain("MEMORY.md");
    expect(settings?.systemPrompt).toContain("memory/YYYY-MM-DD.md");
    expect(settings?.systemPrompt).toContain("MEMORY.md");
  });

  it("falls back to defaults when numeric values are invalid", () => {
    const settings = resolveMemoryFlushSettings({
      agents: {
        defaults: {
          compaction: {
            reserveTokensFloor: Number.NaN,
            memoryFlush: {
              softThresholdTokens: -100,
            },
          },
        },
      },
    });

    expect(settings?.softThresholdTokens).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
    expect(settings?.forceFlushTranscriptBytes).toBe(DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES);
    expect(settings?.reserveTokensFloor).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
  });

  it("parses forceFlushTranscriptBytes from byte-size strings", () => {
    const settings = resolveMemoryFlushSettings({
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              forceFlushTranscriptBytes: "3mb",
            },
          },
        },
      },
    });

    expect(settings?.forceFlushTranscriptBytes).toBe(3 * 1024 * 1024);
  });
});

describe("shouldRunMemoryFlush", () => {
  it("requires totalTokens and threshold", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 0 },
        contextWindowTokens: 16_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
      }),
    ).toBe(false);
  });

  it("skips when entry is missing", () => {
    expect(
      shouldRunMemoryFlush({
        entry: undefined,
        contextWindowTokens: 16_000,
        reserveTokensFloor: 1_000,
        softThresholdTokens: DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
      }),
    ).toBe(false);
  });

  it("skips when under threshold", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 10_000 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: 10_000,
      }),
    ).toBe(false);
  });

  it("triggers at the threshold boundary", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 85 },
        contextWindowTokens: 100,
        reserveTokensFloor: 10,
        softThresholdTokens: 5,
      }),
    ).toBe(true);
  });

  it("skips when already flushed for current compaction count", () => {
    expect(
      shouldRunMemoryFlush({
        entry: {
          totalTokens: 90_000,
          compactionCount: 2,
          memoryFlushCompactionCount: 2,
        },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(false);
  });

  it("runs when above threshold and not flushed", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 96_000, compactionCount: 1 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(true);
  });

  it("ignores stale cached totals", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 96_000, totalTokensFresh: false, compactionCount: 1 },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(false);
  });
});

describe("hasAlreadyFlushedForCurrentCompaction", () => {
  it("returns true when memoryFlushCompactionCount matches compactionCount", () => {
    expect(
      hasAlreadyFlushedForCurrentCompaction({
        compactionCount: 3,
        memoryFlushCompactionCount: 3,
      }),
    ).toBe(true);
  });

  it("returns false when memoryFlushCompactionCount differs", () => {
    expect(
      hasAlreadyFlushedForCurrentCompaction({
        compactionCount: 3,
        memoryFlushCompactionCount: 2,
      }),
    ).toBe(false);
  });

  it("returns false when memoryFlushCompactionCount is undefined", () => {
    expect(
      hasAlreadyFlushedForCurrentCompaction({
        compactionCount: 1,
      }),
    ).toBe(false);
  });

  it("returns false when both counts are 0 (initial state)", () => {
    // When both counts are 0, this represents the initial state (never flushed).
    // We should return false to allow the first memory flush to proceed.
    expect(
      hasAlreadyFlushedForCurrentCompaction({
        compactionCount: 0,
        memoryFlushCompactionCount: 0,
      }),
    ).toBe(false);
  });

  it("returns false when memoryFlushCompactionCount is 0 but compactionCount is missing (treated as 0)", () => {
    // Same as above - initial state, should allow flush
    expect(
      hasAlreadyFlushedForCurrentCompaction({
        memoryFlushCompactionCount: 0,
      }),
    ).toBe(false);
  });

  it("returns false when memoryFlushCompactionCount is 0 but compactionCount has advanced", () => {
    // This means a flush happened before any compaction (at count 0),
    // and now we've compacted at least once. The flush is "behind" current cycle.
    // We should return false to allow a new flush for the current cycle.
    expect(
      hasAlreadyFlushedForCurrentCompaction({
        compactionCount: 1,
        memoryFlushCompactionCount: 0,
      }),
    ).toBe(false);
  });
});

describe("resolveMemoryFlushContextWindowTokens", () => {
  it("falls back to agent config or default tokens", () => {
    expect(resolveMemoryFlushContextWindowTokens({ agentCfgContextTokens: 42_000 })).toBe(42_000);
  });
});

describe("incrementCompactionCount", () => {
  it("increments compaction count", async () => {
    const entry = { sessionId: "s1", updatedAt: Date.now(), compactionCount: 2 } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    const count = await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
    });
    expect(count).toBe(3);

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].compactionCount).toBe(3);
  });

  it("updates totalTokens when tokensAfter is provided", async () => {
    const entry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      compactionCount: 0,
      totalTokens: 180_000,
      inputTokens: 170_000,
      outputTokens: 10_000,
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      tokensAfter: 12_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].compactionCount).toBe(1);
    expect(stored[sessionKey].totalTokens).toBe(12_000);
    // input/output cleared since we only have the total estimate
    expect(stored[sessionKey].inputTokens).toBeUndefined();
    expect(stored[sessionKey].outputTokens).toBeUndefined();
  });

  it("increments compaction count by an explicit amount", async () => {
    const entry = { sessionId: "s1", updatedAt: Date.now(), compactionCount: 2 } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    const count = await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      amount: 2,
    });
    expect(count).toBe(4);

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].compactionCount).toBe(4);
  });

  it("does not update totalTokens when tokensAfter is not provided", async () => {
    const entry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      compactionCount: 0,
      totalTokens: 180_000,
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].compactionCount).toBe(1);
    // totalTokens unchanged
    expect(stored[sessionKey].totalTokens).toBe(180_000);
  });
});

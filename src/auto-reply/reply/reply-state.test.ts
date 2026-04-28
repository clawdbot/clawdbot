import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  hasAlreadyFlushedForCurrentCompaction,
  resolveMemoryFlushContextWindowTokens,
  shouldRunMemoryFlush,
  shouldRunPreflightCompaction,
} from "./memory-flush.js";
import { CURRENT_MESSAGE_MARKER } from "./mentions.js";
import { incrementRunCompactionCount } from "./session-run-accounting.js";
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

async function rotateCompactionSessionFile(params: {
  tempPrefix: string;
  sessionFile: (tmp: string) => string;
  newSessionId: string;
}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), params.tempPrefix));
  tempDirs.push(tmp);
  const storePath = path.join(tmp, "sessions.json");
  const sessionKey = "main";
  const entry = {
    sessionId: "s1",
    sessionFile: params.sessionFile(tmp),
    updatedAt: Date.now(),
    compactionCount: 0,
  } as SessionEntry;
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
  await seedSessionStore({ storePath, sessionKey, entry });
  await incrementCompactionCount({
    sessionEntry: entry,
    sessionStore,
    sessionKey,
    storePath,
    newSessionId: params.newSessionId,
  });
  const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
  const expectedDir = await fs.realpath(tmp);
  return { stored, sessionKey, expectedDir };
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

describe("shouldRunMemoryFlush", () => {
  it("requires totalTokens and threshold", () => {
    expect(
      shouldRunMemoryFlush({
        entry: { totalTokens: 0 },
        contextWindowTokens: 16_000,
        reserveTokensFloor: 20_000,
        softThresholdTokens: 4_000,
      }),
    ).toBe(false);
  });

  it("skips when entry is missing", () => {
    expect(
      shouldRunMemoryFlush({
        entry: undefined,
        contextWindowTokens: 16_000,
        reserveTokensFloor: 1_000,
        softThresholdTokens: 4_000,
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

describe("shouldRunPreflightCompaction", () => {
  it("ignores stale cached totals when no projected token count is provided", () => {
    expect(
      shouldRunPreflightCompaction({
        entry: { totalTokens: 96_000, totalTokensFresh: false },
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(false);
  });

  it("triggers when a projected token count crosses the threshold", () => {
    expect(
      shouldRunPreflightCompaction({
        entry: { totalTokens: 10, totalTokensFresh: false },
        tokenCount: 93_000,
        contextWindowTokens: 100_000,
        reserveTokensFloor: 5_000,
        softThresholdTokens: 2_000,
      }),
    ).toBe(true);
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

  it("treats missing compactionCount as 0", () => {
    expect(
      hasAlreadyFlushedForCurrentCompaction({
        memoryFlushCompactionCount: 0,
      }),
    ).toBe(true);
  });
});

describe("resolveMemoryFlushContextWindowTokens", () => {
  it("falls back to agent config or default tokens", () => {
    expect(resolveMemoryFlushContextWindowTokens({ agentCfgContextTokens: 42_000 })).toBe(42_000);
  });

  it("uses provider-specific configured limits when the same model id exists on multiple providers", () => {
    const cfg = {
      models: {
        providers: {
          "provider-a": { models: [{ id: "shared-model", contextWindow: 200_000 }] },
          "provider-b": { models: [{ id: "shared-model", contextWindow: 512_000 }] },
        },
      },
    };
    expect(
      resolveMemoryFlushContextWindowTokens({
        cfg: cfg as never,
        provider: "provider-b",
        modelId: "shared-model",
      }),
    ).toBe(512_000);
    expect(
      resolveMemoryFlushContextWindowTokens({
        cfg: cfg as never,
        provider: "provider-a",
        modelId: "shared-model",
      }),
    ).toBe(200_000);
  });

  it("prefers agent contextTokens override over the provider configured window", () => {
    const cfg = {
      models: {
        providers: {
          "provider-b": { models: [{ id: "shared-model", contextWindow: 512_000 }] },
        },
      },
    };
    expect(
      resolveMemoryFlushContextWindowTokens({
        cfg: cfg as never,
        provider: "provider-b",
        modelId: "shared-model",
        agentCfgContextTokens: 100_000,
      }),
    ).toBe(100_000);
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

  it("prefers explicit compactionTokensAfter over last-call usage for run accounting", async () => {
    const entry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      compactionCount: 0,
      totalTokens: 180_000,
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    await incrementRunCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      compactionTokensAfter: 12_000,
      lastCallUsage: {
        input: 90_000,
        output: 1_000,
        total: 91_000,
      },
      contextTokensUsed: 200_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(12_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it("falls back to last-call usage when run compactionTokensAfter is non-finite", async () => {
    const entry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      compactionCount: 0,
      totalTokens: 180_000,
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    await incrementRunCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      compactionTokensAfter: Number.POSITIVE_INFINITY,
      lastCallUsage: {
        input: 90_000,
        output: 1_000,
        total: 91_000,
      },
      contextTokensUsed: 200_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(90_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it("ignores non-finite tokensAfter values", async () => {
    const entry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      compactionCount: 0,
      totalTokens: 180_000,
      totalTokensFresh: true,
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      tokensAfter: Number.POSITIVE_INFINITY,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].compactionCount).toBe(1);
    expect(stored[sessionKey].totalTokens).toBe(180_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it("updates sessionId and sessionFile when compaction rotated transcripts", async () => {
    const { stored, sessionKey, expectedDir } = await rotateCompactionSessionFile({
      tempPrefix: "openclaw-compact-rotate-",
      sessionFile: (tmp) => path.join(tmp, "s1-topic-456.jsonl"),
      newSessionId: "s2",
    });
    expect(stored[sessionKey].sessionId).toBe("s2");
    expect(stored[sessionKey].sessionFile).toBe(path.join(expectedDir, "s2-topic-456.jsonl"));
  });

  it("preserves fork transcript filenames when compaction rotates transcripts", async () => {
    const { stored, sessionKey, expectedDir } = await rotateCompactionSessionFile({
      tempPrefix: "openclaw-compact-fork-",
      sessionFile: (tmp) => path.join(tmp, "2026-03-23T12-34-56-789Z_s1.jsonl"),
      newSessionId: "s2",
    });
    expect(stored[sessionKey].sessionId).toBe("s2");
    expect(stored[sessionKey].sessionFile).toBe(
      path.join(expectedDir, "2026-03-23T12-34-56-789Z_s2.jsonl"),
    );
  });

  it("keeps rewritten absolute sessionFile paths that stay inside the sessions directory", async () => {
    const { stored, sessionKey, expectedDir } = await rotateCompactionSessionFile({
      tempPrefix: "openclaw-compact-unsafe-",
      sessionFile: (tmp) => path.join(tmp, "outside", "s1.jsonl"),
      newSessionId: "s2",
    });
    expect(stored[sessionKey].sessionId).toBe("s2");
    expect(stored[sessionKey].sessionFile).toBe(path.join(expectedDir, "outside", "s2.jsonl"));
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

  it("updates sessionId and sessionFile when newSessionId is provided", async () => {
    const entry = {
      sessionId: "old-session-id",
      sessionFile: "old-session-id.jsonl",
      updatedAt: Date.now(),
      compactionCount: 1,
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      newSessionId: "new-session-id",
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    const expectedSessionDir = await fs.realpath(path.dirname(storePath));
    expect(stored[sessionKey].sessionId).toBe("new-session-id");
    expect(stored[sessionKey].sessionFile).toBe(
      path.join(expectedSessionDir, "new-session-id.jsonl"),
    );
    expect(stored[sessionKey].compactionCount).toBe(2);
  });

  it("does not update sessionFile when newSessionId matches current sessionId", async () => {
    const entry = {
      sessionId: "same-id",
      sessionFile: "same-id.jsonl",
      updatedAt: Date.now(),
      compactionCount: 0,
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);

    await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      newSessionId: "same-id",
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].sessionId).toBe("same-id");
    expect(stored[sessionKey].sessionFile).toBe("same-id.jsonl");
    expect(stored[sessionKey].compactionCount).toBe(1);
  });

  it("updates sessionFile when rotation keeps the same sessionId", async () => {
    const entry = {
      sessionId: "same-id",
      sessionFile: "same-id.jsonl",
      updatedAt: Date.now(),
      compactionCount: 0,
    } as SessionEntry;
    const { storePath, sessionKey, sessionStore } = await createCompactionSessionFixture(entry);
    const rotatedSessionFile = path.join(path.dirname(storePath), "rotated-same-id.jsonl");

    await incrementCompactionCount({
      sessionEntry: entry,
      sessionStore,
      sessionKey,
      storePath,
      newSessionId: "same-id",
      newSessionFile: rotatedSessionFile,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].sessionId).toBe("same-id");
    expect(stored[sessionKey].sessionFile).toBe(rotatedSessionFile);
    expect(stored[sessionKey].compactionCount).toBe(1);
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

import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn, Usage } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import {
  calculateContextTokens,
  compact,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  generateSummary,
  getLastAssistantUsage,
  prepareCompaction,
  shouldCompact,
} from "./compaction.js";
import { createFileOps } from "./utils.js";

function createUsage(totalTokens: number): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextUsage: { state: "available", promptTokens: totalTokens, totalTokens },
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistant(text: string, usage: Usage, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp,
  };
}

function createBashMessage(
  output: string,
  timestamp: number,
  excludeFromContext: boolean,
): AgentMessage {
  return {
    role: "bashExecution",
    command: "print output",
    output,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp,
    excludeFromContext,
  };
}

function createMessageEntry(message: AgentMessage, index: number): SessionTreeEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}

function createProjectedEntry(
  type: "custom_message" | "branch_summary",
  index: number,
  content: string,
): SessionTreeEntry {
  const common = {
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(index + 1).toISOString(),
  };
  return type === "custom_message"
    ? { ...common, type, customType: "test", content, display: true }
    : { ...common, type, fromId: common.parentId ?? common.id, summary: content };
}

describe("shouldCompact", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "skips an invalid context window of %s",
    (contextWindow) => {
      expect(
        shouldCompact(1, contextWindow, {
          enabled: true,
          reserveTokens: 16_384,
          keepRecentTokens: 20_000,
        }),
      ).toBe(false);
    },
  );
});

describe("calculateContextTokens", () => {
  it("prefers the final-iteration context snapshot over aggregate billing usage", () => {
    expect(
      calculateContextTokens({
        input: 12,
        output: 15_104,
        cacheRead: 819_661,
        cacheWrite: 93_130,
        contextUsage: {
          state: "available",
          promptTokens: 148_874,
          totalTokens: 163_978,
        },
        totalTokens: 927_907,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toBe(163_978);
  });

  it("preserves the numeric compatibility fallback when the snapshot is unavailable", () => {
    expect(
      calculateContextTokens({
        input: 12,
        output: 15_104,
        cacheRead: 819_661,
        cacheWrite: 93_130,
        contextUsage: { state: "unavailable" },
        totalTokens: 927_907,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toBe(927_907);
  });

  it("estimates the transcript instead of using aggregate billing when context is unavailable", () => {
    const estimate = estimateContextTokens([
      { role: "user", content: "hello", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        usage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: { state: "unavailable" },
          totalTokens: 927_907,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      },
    ]);

    expect(estimate.tokens).toBeLessThan(927_907);
    expect(estimate.tokens).toBeGreaterThan(0);
    expect(estimate.usageTokens).toBe(0);
    expect(estimate.lastUsageIndex).toBeNull();
  });

  it("uses the previous exact snapshot and estimates only the unavailable tail", () => {
    const estimate = estimateContextTokens([
      {
        role: "assistant",
        content: [{ type: "text", text: "previous" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        usage: {
          input: 12,
          output: 1_000,
          cacheRead: 148_862,
          cacheWrite: 0,
          contextUsage: {
            state: "available",
            promptTokens: 148_874,
            totalTokens: 149_874,
          },
          totalTokens: 149_874,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
      { role: "user", content: "next", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-fable-5",
        usage: {
          input: 12,
          output: 15_104,
          cacheRead: 819_661,
          cacheWrite: 93_130,
          contextUsage: { state: "unavailable" },
          totalTokens: 927_907,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    ]);

    expect(estimate.usageTokens).toBe(149_874);
    expect(estimate.tokens).toBeGreaterThan(149_874);
    expect(estimate.tokens).toBeLessThan(927_907);
    expect(estimate.lastUsageIndex).toBe(0);
  });

  it("does not scan past a zero unavailable context marker", () => {
    const messages: AgentMessage[] = [
      createAssistant("old cumulative turn", createUsage(950), 0),
      {
        ...createAssistant("usage unavailable", createUsage(0), 1),
        usage: {
          ...createUsage(0),
          contextUsage: { state: "unavailable" },
        },
      },
    ];
    const estimate = estimateContextTokens(messages);

    expect(estimate.usageTokens).toBe(0);
    expect(estimate.lastUsageIndex).toBeNull();
    expect(estimate.tokens).toBeGreaterThan(0);
    expect(estimate.tokens).toBeLessThan(950);
    expect(getLastAssistantUsage(messages.map(createMessageEntry))).toBeUndefined();
  });

  it("treats legacy CLI usage without context provenance as a barrier", () => {
    const legacyCli = {
      ...createAssistant("legacy CLI", createUsage(950), 1),
      api: "cli",
      usage: { ...createUsage(950), contextUsage: undefined },
    };
    const messages = [createAssistant("old", createUsage(900), 0), legacyCli];

    expect(estimateContextTokens(messages).usageTokens).toBe(0);
    expect(getLastAssistantUsage(messages.map(createMessageEntry))).toBeUndefined();
  });

  it("ignores an all-zero terminal usage block", () => {
    const validUsage = createUsage(20);
    const messages: AgentMessage[] = [
      createAssistant("complete", validUsage, 1),
      { role: "user", content: "continue", timestamp: 2 },
      createAssistant("partial", createUsage(0), 3),
    ];
    const entries = messages.map(createMessageEntry);

    expect(getLastAssistantUsage(entries)).toBe(validUsage);
    expect(estimateContextTokens(messages)).toMatchObject({
      usageTokens: 20,
      lastUsageIndex: 0,
    });
    expect(estimateContextTokens(messages).trailingTokens).toBeGreaterThan(0);
  });

  it("scans past a sparse assistant row to retain older valid usage", () => {
    const validUsage = createUsage(20);
    const sparseAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "seeded without provider usage" }],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      stopReason: "stop",
      timestamp: 2,
    } as AgentMessage;
    const messages = [createAssistant("complete", validUsage, 1), sparseAssistant];

    expect(getLastAssistantUsage(messages.map(createMessageEntry))).toBe(validUsage);
    expect(estimateContextTokens(messages)).toMatchObject({
      usageTokens: 20,
      lastUsageIndex: 0,
    });
    expect(estimateContextTokens(messages).trailingTokens).toBeGreaterThan(0);
  });
});

describe("session-entry compaction budgeting", () => {
  it.each([
    {
      kind: "shell",
      createMessage: (excludeFromContext: boolean) =>
        createBashMessage("x".repeat(80_000), 2, excludeFromContext),
    },
    {
      kind: "custom",
      createMessage: (excludeFromContext: boolean): AgentMessage => ({
        role: "custom",
        customType: "openclaw.operator-activity",
        content: "x".repeat(80_004),
        display: excludeFromContext,
        excludeFromContext,
        timestamp: 2,
      }),
    },
  ])(
    "counts visible $kind activity while ignoring excluded activity after provider usage",
    ({ createMessage }) => {
      const hidden = createMessage(true);
      const visible = createMessage(false);
      const assistant = createAssistant("done", createUsage(42), 1);
      const latest: AgentMessage = { role: "user", content: "continue", timestamp: 3 };

      expect(estimateTokens(hidden)).toBe(0);
      expect(estimateTokens(visible)).toBeGreaterThan(20_000);
      expect(estimateContextTokens([assistant, hidden, latest])).toMatchObject({
        tokens: 44,
        usageTokens: 42,
        trailingTokens: 2,
        lastUsageIndex: 0,
      });
      expect(estimateContextTokens([assistant, visible, latest]).trailingTokens).toBeGreaterThan(
        20_000,
      );
    },
  );

  it("never rewinds a retained visible turn onto an excluded shell-history row", () => {
    const entries: SessionTreeEntry[] = [
      createMessageEntry({ role: "user", content: "original request", timestamp: 1 }, 0),
      createMessageEntry(createAssistant("earlier", createUsage(10), 2), 1),
      createMessageEntry(createBashMessage("x".repeat(80_000), 3, true), 2),
      createMessageEntry({ role: "user", content: "recent turn", timestamp: 4 }, 3),
      createMessageEntry(createAssistant("ok", createUsage(10), 5), 4),
    ];

    expect(findCutPoint(entries, 0, entries.length, 2)).toEqual({
      firstKeptEntryIndex: 3,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
  });

  it("omits private shell history from a genuine split-turn summary prefix", () => {
    const entries: SessionTreeEntry[] = [
      createMessageEntry({ role: "user", content: "original request", timestamp: 1 }, 0),
      createMessageEntry(createAssistant("earlier work", createUsage(10), 2), 1),
      createMessageEntry(createBashMessage("private output ".repeat(6_000), 3, true), 2),
      createMessageEntry(createAssistant("latest", createUsage(10), 4), 3),
    ];

    expect(findCutPoint(entries, 0, entries.length, 1)).toEqual({
      firstKeptEntryIndex: 3,
      turnStartIndex: 0,
      isSplitTurn: true,
    });

    const preparation = prepareCompaction(entries, {
      enabled: true,
      reserveTokens: 0,
      keepRecentTokens: 1,
    });

    expect(preparation.ok).toBe(true);
    if (!preparation.ok || !preparation.value) {
      throw new Error("expected a genuine split turn to remain compactable");
    }
    expect(preparation.value).toMatchObject({
      firstKeptEntryId: "entry-3",
      isSplitTurn: true,
      tokensBefore: 10,
      turnPrefixMessages: [{ role: "user" }, { role: "assistant" }],
    });
    expect(JSON.stringify(preparation.value)).not.toContain("private output");
    expect(JSON.stringify(entries)).toContain("private output");
  });

  it("applies the shared common-CJK budget heuristic", () => {
    expect(estimateTokens({ role: "user", content: "hello world", timestamp: 1 })).toBe(3);
    expect(estimateTokens({ role: "user", content: "你好世界", timestamp: 1 })).toBe(4);
    expect(estimateTokens({ role: "user", content: "こんにちは", timestamp: 1 })).toBe(5);
    expect(estimateTokens({ role: "user", content: "안녕하세요", timestamp: 1 })).toBe(5);
  });

  it("uses conservative weights for halfwidth and supplementary CJK", () => {
    expect(estimateTokens({ role: "user", content: "ｺﾝﾆﾁﾊ", timestamp: 1 })).toBe(10);
    expect(
      estimateTokens({ role: "user", content: String.fromCodePoint(0xffa1), timestamp: 1 }),
    ).toBe(2);
    expect(
      estimateTokens({ role: "user", content: String.fromCodePoint(0x20000), timestamp: 1 }),
    ).toBe(4);
    expect(
      estimateTokens({ role: "user", content: String.fromCodePoint(0x30000), timestamp: 1 }),
    ).toBe(4);
  });

  it("uses a conservative weight for rare BMP CJK", () => {
    expect(
      estimateTokens({ role: "user", content: String.fromCodePoint(0x3400), timestamp: 1 }),
    ).toBe(3);
    expect(
      estimateTokens({ role: "user", content: String.fromCodePoint(0x9fff), timestamp: 1 }),
    ).toBe(3);
  });

  it("accounts for decomposed Hangul and compatibility forms", () => {
    expect(
      estimateTokens({ role: "user", content: "안녕하세요".normalize("NFD"), timestamp: 1 }),
    ).toBe(36);
    expect(
      estimateTokens({ role: "user", content: String.fromCodePoint(0xfe10), timestamp: 1 }),
    ).toBe(2);
    expect(
      estimateTokens({ role: "user", content: String.fromCodePoint(0xffe0), timestamp: 1 }),
    ).toBe(2);
  });

  it("uses a conservative weight for supplementary Japanese forms", () => {
    expect(
      estimateTokens({ role: "user", content: String.fromCodePoint(0x1aff0), timestamp: 1 }),
    ).toBe(4);
    expect(
      estimateTokens({ role: "user", content: String.fromCodePoint(0x1f200), timestamp: 1 }),
    ).toBe(4);
  });

  it("uses measured weights for CJK script-extension marks", () => {
    expect(
      estimateTokens({ role: "user", content: String.fromCodePoint(0x00b7), timestamp: 1 }),
    ).toBe(1);
    expect(estimateTokens({ role: "user", content: "·".repeat(32), timestamp: 1 })).toBe(32);
    expect(
      estimateTokens({ role: "user", content: String.fromCodePoint(0x02ca), timestamp: 1 }),
    ).toBe(2);
    expect(
      estimateTokens({ role: "user", content: String.fromCodePoint(0x1d360), timestamp: 1 }),
    ).toBe(3);
  });

  it("uses CJK-aware token estimates when choosing the retained tail", () => {
    const entries: SessionTreeEntry[] = [
      createMessageEntry({ role: "user", content: "start", timestamp: 1 }, 0),
      createMessageEntry(createAssistant("ok", createUsage(2), 2), 1),
      createMessageEntry({ role: "user", content: "早上好", timestamp: 3 }, 2),
      createMessageEntry(createAssistant("ok", createUsage(2), 4), 3),
      createMessageEntry({ role: "user", content: "你好世界", timestamp: 5 }, 4),
    ];

    expect(findCutPoint(entries, 0, entries.length, 4)).toEqual({
      firstKeptEntryIndex: 4,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
  });

  it.each(["custom_message", "branch_summary"] as const)(
    "counts a %s entry that projects into model context",
    (entryType) => {
      const entries: SessionTreeEntry[] = [
        createMessageEntry({ role: "user", content: "hi", timestamp: 1 }, 0),
        createMessageEntry(createAssistant("hello", createUsage(2), 2), 1),
        createProjectedEntry(entryType, 2, "x".repeat(4_000)),
        createMessageEntry(createAssistant("ok", createUsage(2), 4), 3),
      ];

      expect(findCutPoint(entries, 0, entries.length, 1)).toMatchObject({
        firstKeptEntryIndex: 3,
        turnStartIndex: 2,
        isSplitTurn: true,
      });
      expect(findCutPoint(entries, 0, entries.length, 2)).toEqual({
        firstKeptEntryIndex: 2,
        turnStartIndex: -1,
        isSplitTurn: false,
      });
    },
  );

  it.each(["custom_message", "branch_summary"] as const)(
    "does not rewind across adjacent %s entries",
    (entryType) => {
      const entries: SessionTreeEntry[] = [
        createMessageEntry({ role: "user", content: "hi", timestamp: 1 }, 0),
        createMessageEntry(createAssistant("hello", createUsage(2), 2), 1),
        createProjectedEntry(entryType, 2, "x".repeat(4_000)),
        createProjectedEntry(entryType, 3, "y".repeat(4_000)),
        createMessageEntry(createAssistant("ok", createUsage(2), 5), 4),
      ];

      expect(findCutPoint(entries, 0, entries.length, 2)).toEqual({
        firstKeptEntryIndex: 3,
        turnStartIndex: -1,
        isSplitTurn: false,
      });
    },
  );

  it("skips compaction when no history or turn prefix would be summarized", () => {
    const entries = [
      createMessageEntry({ role: "user", content: "hello", timestamp: 1 }, 0),
      createMessageEntry(createAssistant("done", createUsage(2), 2), 1),
    ];

    expect(
      prepareCompaction(entries, {
        enabled: true,
        reserveTokens: 0,
        keepRecentTokens: 10_000,
      }),
    ).toEqual({ ok: true, value: undefined });
  });

  it("plans provider-triggered cuts in provider token units", () => {
    const entries = [
      createMessageEntry({ role: "user", content: "first", timestamp: 1 }, 0),
      createMessageEntry(createAssistant("ok", createUsage(2), 2), 1),
      createMessageEntry({ role: "user", content: "second", timestamp: 3 }, 2),
      createMessageEntry(createAssistant("ok", createUsage(2), 4), 3),
      createMessageEntry({ role: "user", content: "latest", timestamp: 5 }, 4),
      createMessageEntry(createAssistant("done", createUsage(170_000), 6), 5),
    ];

    const result = prepareCompaction(entries, {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value) {
      throw new Error("expected provider usage to produce a compactable prefix");
    }
    expect(result.value.firstKeptEntryId).toBe("entry-4");
    expect(result.value.messagesToSummarize.length).toBeGreaterThan(0);
  });

  it("keeps reset-filtered tool rows out of later compaction input", () => {
    const entries: SessionTreeEntry[] = [
      createMessageEntry({ role: "user", content: "discarded", timestamp: 1 }, 0),
      createMessageEntry({ role: "user", content: "kept question", timestamp: 2 }, 1),
      createMessageEntry(
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "hidden tool result" }],
          isError: false,
          timestamp: 3,
        },
        2,
      ),
      createMessageEntry(createAssistant("kept answer", createUsage(2), 4), 3),
      {
        type: "reset",
        id: "entry-4",
        parentId: "entry-3",
        timestamp: new Date(5).toISOString(),
        reason: "new",
        firstKeptEntryId: "entry-1",
      },
      createMessageEntry({ role: "user", content: "post reset", timestamp: 6 }, 5),
      createMessageEntry(createAssistant("new answer", createUsage(2), 7), 6),
    ];

    const result = prepareCompaction(entries, {
      enabled: true,
      reserveTokens: 0,
      keepRecentTokens: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value) {
      throw new Error("expected reset transcript to be compactable");
    }
    expect(JSON.stringify(result.value.messagesToSummarize)).not.toContain("hidden tool result");
    expect(JSON.stringify(result.value.turnPrefixMessages)).not.toContain("hidden tool result");
    expect(["entry-5", "entry-6"]).toContain(result.value.firstKeptEntryId);
  });

  it("retains only occurrence-paired reset tool results in compaction input", () => {
    const assistantToolCall = (timestamp: number): AssistantMessage => ({
      ...createAssistant("", createUsage(2), timestamp),
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      stopReason: "toolUse",
    });
    const toolResult = (timestamp: number, text: string): AgentMessage => ({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp,
    });
    const entries: SessionTreeEntry[] = [
      createMessageEntry({ role: "user", content: "discarded", timestamp: 1 }, 0),
      createMessageEntry({ role: "user", content: "kept", timestamp: 2 }, 1),
      createMessageEntry(assistantToolCall(3), 2),
      createMessageEntry(toolResult(4, "first result"), 3),
      createMessageEntry(assistantToolCall(5), 4),
      createMessageEntry(toolResult(6, "second result"), 5),
      createMessageEntry(toolResult(7, "orphan result"), 6),
      {
        type: "reset",
        id: "entry-7",
        parentId: "entry-6",
        timestamp: new Date(8).toISOString(),
        reason: "new",
        firstKeptEntryId: "entry-1",
      },
      createMessageEntry({ role: "user", content: "post reset", timestamp: 9 }, 8),
      createMessageEntry(createAssistant("new answer", createUsage(2), 10), 9),
    ];

    const result = prepareCompaction(entries, {
      enabled: true,
      reserveTokens: 0,
      keepRecentTokens: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value) {
      throw new Error("expected reset transcript to be compactable");
    }
    const summarized = JSON.stringify(result.value.messagesToSummarize);
    expect(summarized).toContain("first result");
    expect(summarized).toContain("second result");
    expect(summarized).not.toContain("orphan result");
  });

  it("moves the cut earlier when a reset kept-tail prelude consumes the compaction budget", () => {
    const largePrelude = "kept context ".repeat(4_000);
    const postResetEntries: SessionTreeEntry[] = [
      createMessageEntry({ role: "user", content: "post one ".repeat(500), timestamp: 4 }, 3),
      createMessageEntry(createAssistant("answer one ".repeat(500), createUsage(2), 5), 4),
      createMessageEntry({ role: "user", content: "post two ".repeat(500), timestamp: 6 }, 5),
      createMessageEntry(createAssistant("answer two ".repeat(500), createUsage(2), 7), 6),
    ];
    const buildEntries = (firstKeptEntryId?: string): SessionTreeEntry[] => [
      createMessageEntry({ role: "user", content: largePrelude, timestamp: 1 }, 0),
      {
        type: "reset",
        id: "entry-1",
        parentId: "entry-0",
        timestamp: new Date(2).toISOString(),
        reason: "new",
        ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
      },
      ...postResetEntries.map((entry, index) =>
        Object.assign({}, entry, {
          id: `entry-${index + 2}`,
          parentId: `entry-${index + 1}`,
        }),
      ),
    ];
    const settings = { enabled: true, reserveTokens: 0, keepRecentTokens: 500 };
    const withoutPrelude = prepareCompaction(buildEntries(), settings);
    const withPrelude = prepareCompaction(buildEntries("entry-0"), settings);

    expect(withoutPrelude.ok && withoutPrelude.value).toBeTruthy();
    expect(withPrelude.ok && withPrelude.value).toBeTruthy();
    if (!withoutPrelude.ok || !withoutPrelude.value || !withPrelude.ok || !withPrelude.value) {
      throw new Error("expected both reset transcripts to be compactable");
    }
    const cutIndex = (entryId: string) => Number.parseInt(entryId.slice("entry-".length), 10);
    expect(cutIndex(withPrelude.value.firstKeptEntryId)).toBeLessThan(
      cutIndex(withoutPrelude.value.firstKeptEntryId),
    );
  });
});

describe("prepareCompaction when the last entry is a compaction record", () => {
  const settings = {
    enabled: true,
    reserveTokens: 0,
    keepRecentTokens: 1,
  };
  it.each([
    { name: "ordinary", fromHook: false, compactable: true },
    { name: "safeguard", fromHook: true, compactable: false },
  ])("handles a $name trailing compaction boundary", ({ fromHook, compactable }) => {
    const largeContent = "x".repeat(200_000);
    const entries: SessionTreeEntry[] = [
      createMessageEntry({ role: "user", content: "original request", timestamp: 1 }, 0),
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "entry-0",
        timestamp: new Date(2).toISOString(),
        summary: "earlier summary",
        firstKeptEntryId: "entry-0",
        tokensBefore: 200_000,
      },
      createMessageEntry({ role: "user", content: largeContent, timestamp: 3 }, 2),
      createMessageEntry(createAssistant(largeContent, createUsage(10), 4), 3),
      createMessageEntry({ role: "user", content: largeContent, timestamp: 5 }, 4),
      createMessageEntry(createAssistant("recent reply tail", createUsage(10), 6), 5),
      {
        type: "compaction",
        id: "compaction-2",
        parentId: "entry-5",
        timestamp: new Date(7).toISOString(),
        summary: "later summary",
        firstKeptEntryId: "entry-2",
        tokensBefore: 200_000,
        fromHook,
      },
    ];

    const result = prepareCompaction(entries, settings);

    expect(result.ok).toBe(true);
    expect(Boolean(result.ok && result.value)).toBe(compactable);
    if (!compactable) {
      return;
    }
    if (!result.ok || !result.value) {
      throw new Error("expected a trailing compaction record with new turns to remain compactable");
    }
    expect(result.value.messagesToSummarize.length).toBeGreaterThan(0);
    expect(result.value.previousSummary).toBe("later summary");
    expect(result.value.firstKeptEntryId).not.toBe("entry-2");

    const nextResult = prepareCompaction(
      [
        ...entries,
        {
          type: "compaction",
          id: "compaction-3",
          parentId: "compaction-2",
          timestamp: new Date(8).toISOString(),
          summary: "final summary",
          firstKeptEntryId: result.value.firstKeptEntryId,
          tokensBefore: result.value.tokensBefore,
        },
      ],
      settings,
    );

    expect(nextResult.ok).toBe(true);
    expect(nextResult.ok ? nextResult.value : undefined).toBeUndefined();
  });

  it.each([
    { name: "non-record", details: "invalid" },
    { name: "missing fields", details: { readFiles: ["src/read.ts"] } },
    { name: "wrong field types", details: { readFiles: "src/read.ts", modifiedFiles: [] } },
    {
      name: "mixed element types",
      details: { readFiles: ["src/read.ts", 1], modifiedFiles: ["src/write.ts"] },
    },
  ] satisfies Array<{ name: string; details: unknown }>)(
    "ignores $name persisted compaction details",
    ({ details }) => {
      const largeContent = "x".repeat(200_000);
      const entries: SessionTreeEntry[] = [
        createMessageEntry({ role: "user", content: "original request", timestamp: 1 }, 0),
        {
          type: "compaction",
          id: "entry-1",
          parentId: "entry-0",
          timestamp: new Date(2).toISOString(),
          summary: "earlier summary",
          firstKeptEntryId: "entry-0",
          tokensBefore: 200_000,
          details,
        },
        createMessageEntry({ role: "user", content: largeContent, timestamp: 3 }, 2),
        createMessageEntry(createAssistant(largeContent, createUsage(10), 4), 3),
        createMessageEntry({ role: "user", content: "recent tail", timestamp: 5 }, 4),
      ];

      const result = prepareCompaction(entries, settings);

      expect(result.ok).toBe(true);
      if (!result.ok || !result.value) {
        throw new Error("expected malformed persisted details to be ignored");
      }
      expect(result.value.previousSummaryDetails).toBeUndefined();
      expect([...result.value.fileOps.read]).toEqual([]);
      expect([...result.value.fileOps.written]).toEqual([]);
      expect([...result.value.fileOps.edited]).toEqual([]);
    },
  );
});

describe("generateSummary thinking options", () => {
  it("consumes the decorated stream before reading its result", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "test-api",
      provider: "test-provider",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
    };
    let consumed = false;
    const streamFn = vi.fn<StreamFn>(() => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            consumed = true;
            return { done: true as const, value: undefined };
          },
        };
      },
      async result() {
        if (!consumed) {
          throw new Error("stream result read before iteration");
        }
        return createAssistant("summary", createUsage(1), 1);
      },
    }));

    await generateSummary(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      1_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );

    expect(consumed).toBe(true);
  });

  it("maps explicit Fable off to low effort for compaction", async () => {
    const model: Model = {
      id: "production-fable",
      name: "Production Fable",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      params: { canonicalModelId: "claude-fable-5" },
    };
    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    const streamFn = vi.fn<StreamFn>((_model, context, options) => {
      expect(options?.reasoning).toBe("low");
      expect(context.systemPrompt).toContain("user and an AI assistant");
      expect(context.systemPrompt).not.toContain("AI coding assistant");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: summaryMessage });
      stream.end();
      return stream;
    });

    const result = await generateSummary(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      1000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "off",
      streamFn,
    );

    expect(result).toEqual({ ok: true, value: "summary" });
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it.each([
    ["empty", []],
    ["whitespace-only", [{ type: "text" as const, text: " \n\t " }]],
    ["reasoning-only", [{ type: "thinking" as const, thinking: "internal summary reasoning" }]],
  ])("rejects %s compaction output", async (_name, content) => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "test-api",
      provider: "test-provider",
      baseUrl: "https://example.test",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
    };
    const streamFn = vi.fn<StreamFn>(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: createUsage(1),
          stopReason: "stop",
          timestamp: 1,
        },
      });
      stream.end();
      return stream;
    });

    const result = await generateSummary(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      1_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "low",
      streamFn,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected empty compaction output to fail");
    }
    expect(result.error).toMatchObject({
      name: "CompactionError",
      code: "summarization_failed",
      message: "Summarization failed: model returned no summary text",
    });
  });
});

describe("split-turn compaction", () => {
  it("serializes history and turn-prefix summaries", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "test-api",
      provider: "test-provider",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
    };
    let active = 0;
    let maxActive = 0;
    let callCount = 0;
    const streamFn = vi.fn<StreamFn>(() => {
      active++;
      maxActive = Math.max(maxActive, active);
      callCount++;
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        active--;
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: `summary-${callCount}` }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        };
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      }, 5);
      return stream;
    });
    const result = await compact(
      {
        firstKeptEntryId: "kept-entry",
        messagesToSummarize: [{ role: "user", content: "history", timestamp: 1 }],
        turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: 2 }],
        isSplitTurn: true,
        tokensBefore: 100,
        fileOps: createFileOps(),
        settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
      },
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );

    expect(result.ok).toBe(true);
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });
});

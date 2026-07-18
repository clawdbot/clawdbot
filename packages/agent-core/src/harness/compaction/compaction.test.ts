import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn, Usage } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import {
  calculateContextTokens,
  compact,
  estimateContextTokens,
  findCutPoint,
  generateSummary,
  getLastAssistantUsage,
  prepareCompaction,
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
});

describe("session-entry compaction budgeting", () => {
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
});

describe("generateSummary thinking options", () => {
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

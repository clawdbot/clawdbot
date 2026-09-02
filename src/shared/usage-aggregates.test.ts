import { describe, expect, it } from "vitest";
import type { SessionCostSummary } from "../infra/session-cost-usage.types.js";
import {
  createUsageAggregateAccumulator,
  usageDailyModelIdentity,
  usageModelIdentity,
} from "./usage-aggregates.js";

function usage(overrides: Partial<SessionCostSummary> = {}): SessionCostSummary {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
    ...overrides,
  };
}

describe("shared/usage-aggregates", () => {
  it("builds collision-free model identities with legacy unknown grouping", () => {
    expect(usageModelIdentity("fixture", "bedrock::arn")).not.toBe(
      usageModelIdentity("fixture::bedrock", "arn"),
    );
    expect(usageDailyModelIdentity("2026-02-01", "fixture", "bedrock:arn")).not.toBe(
      usageDailyModelIdentity("2026-02-01", "fixture:bedrock", "arn"),
    );
    expect(usageModelIdentity("fixture\0bedrock", "arn")).not.toBe(
      usageModelIdentity("fixture", "bedrock\0arn"),
    );
    expect(usageModelIdentity()).toBe(usageModelIdentity("unknown", "unknown"));
  });

  it("accounts for every supplied row without conflating matching session IDs or mutating usage", () => {
    const accumulator = createUsageAggregateAccumulator();
    const first = usage({
      sessionId: "same-id",
      firstActivity: 0,
      durationMs: 500,
      input: 10,
      cacheRead: 3,
      totalTokens: 13,
      totalCost: 2,
      inputCost: 1,
      cacheReadCost: 1,
      missingCostEntries: 1,
      missingCostByModel: { "fixture/unpriced": 1 },
      messageCounts: { total: 3, user: 1, assistant: 2, toolCalls: 3, toolResults: 2, errors: 1 },
      toolUsage: {
        totalCalls: 3,
        uniqueTools: 2,
        tools: [
          { name: "read", count: 2 },
          { name: "write", count: 1 },
        ],
      },
    });
    const second = usage({
      sessionId: "same-id",
      durationMs: 900,
      output: 5,
      cacheWrite: 2,
      totalTokens: 7,
      totalCost: 4,
      outputCost: 3,
      cacheWriteCost: 1,
      missingCostEntries: 2,
      missingCostByModel: { "fixture/unpriced": 2 },
      messageCounts: { total: 2, user: 1, assistant: 1, toolCalls: 2, toolResults: 1, errors: 0 },
      toolUsage: { totalCalls: 2, uniqueTools: 1, tools: [{ name: "read", count: 2 }] },
    });
    const original = structuredClone([first, second]);
    accumulator.add({ usage: first, agentId: "first", channel: "discord" });
    accumulator.add({ usage: second, agentId: "second", channel: "telegram" });
    accumulator.add({ usage: usage({ totalTokens: 30 }) });
    accumulator.add({ usage: null, agentId: "cold" });

    const aggregates = accumulator.finish();
    expect(accumulator.totals).toEqual({
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 50,
      totalCost: 6,
      inputCost: 1,
      outputCost: 3,
      cacheReadCost: 1,
      cacheWriteCost: 1,
      missingCostEntries: 3,
      missingCostByModel: { "fixture/unpriced": 3 },
    });
    expect(aggregates.sessionCount).toBe(2);
    expect(aggregates.longestSessionDurationMs).toBe(900);
    expect(aggregates.messages).toEqual({
      total: 5,
      user: 2,
      assistant: 3,
      toolCalls: 5,
      toolResults: 3,
      errors: 1,
    });
    expect(aggregates.tools).toEqual({
      totalCalls: 5,
      uniqueTools: 2,
      tools: [
        { name: "read", count: 4 },
        { name: "write", count: 1 },
      ],
    });
    expect(aggregates.byAgent.map(({ agentId, totals }) => [agentId, totals.totalTokens])).toEqual([
      ["second", 7],
      ["first", 13],
    ]);
    expect(aggregates.byChannel.map(({ channel }) => channel)).toEqual(["telegram", "discord"]);
    expect([first, second]).toEqual(original);
  });

  it("merges models and providers by identity and ranks equal costs by token usage", () => {
    const accumulator = createUsageAggregateAccumulator();
    for (const [provider, model, tokens] of [
      ["fixture", "bedrock::arn", 10],
      ["fixture::bedrock", "arn", 20],
      ["fixture", "bedrock::arn", 15],
    ] as const) {
      accumulator.add({
        usage: usage({
          modelUsage: [{ provider, model, count: 1, totals: usage({ totalTokens: tokens }) }],
          dailyModelUsage: [{ date: "2026-03-12", provider, model, tokens, cost: 0, count: 1 }],
        }),
      });
    }
    const aggregates = accumulator.finish();
    expect(aggregates.byModel).toMatchObject([
      { provider: "fixture", model: "bedrock::arn", count: 2, totals: { totalTokens: 25 } },
      { provider: "fixture::bedrock", model: "arn", count: 1, totals: { totalTokens: 20 } },
    ]);
    expect(aggregates.byProvider).toMatchObject([
      { provider: "fixture", model: undefined, count: 2, totals: { totalTokens: 25 } },
      { provider: "fixture::bedrock", model: undefined, count: 1, totals: { totalTokens: 20 } },
    ]);
    expect(aggregates.modelDaily).toEqual([
      {
        date: "2026-03-12",
        provider: "fixture",
        model: "bedrock::arn",
        tokens: 25,
        cost: 0,
        count: 2,
      },
      {
        date: "2026-03-12",
        provider: "fixture::bedrock",
        model: "arn",
        tokens: 20,
        cost: 0,
        count: 1,
      },
    ]);
  });

  it("merges overlapping daily buckets and uses weighted latency summaries", () => {
    const accumulator = createUsageAggregateAccumulator();
    const earlier = "2026-03-11";
    const later = "2026-03-12";
    const quick = { count: 2, avgMs: 50, minMs: 20, maxMs: 90, p95Ms: 80 };
    const slow = { count: 1, avgMs: 120, minMs: 120, maxMs: 120, p95Ms: 120 };
    accumulator.add({
      usage: usage({
        latency: quick,
        dailyLatency: [{ date: later, ...quick }],
        dailyBreakdown: [
          { date: later, tokens: 3, cost: 4 },
          { date: earlier, tokens: 5, cost: 6 },
        ],
        dailyModelUsage: [
          { date: later, provider: "fixture", model: "one", tokens: 3, cost: 4, count: 2 },
        ],
      }),
    });
    accumulator.add({
      usage: usage({
        latency: slow,
        dailyLatency: [
          { date: later, ...slow },
          { date: earlier, ...slow },
        ],
        dailyBreakdown: [{ date: later, tokens: 7, cost: 8 }],
        dailyMessageCounts: [
          { date: later, total: 9, user: 5, assistant: 4, toolCalls: 2, toolResults: 2, errors: 1 },
        ],
        dailyModelUsage: [
          { date: later, provider: "fixture", model: "two", tokens: 7, cost: 8, count: 1 },
          { date: earlier, provider: "fixture", model: "one", tokens: 5, cost: 6, count: 1 },
        ],
      }),
    });
    const aggregates = accumulator.finish();
    expect(aggregates.latency).toEqual({
      count: 3,
      avgMs: 220 / 3,
      minMs: 20,
      maxMs: 120,
      p95Ms: 120,
    });
    expect(aggregates.dailyLatency).toEqual([
      { date: earlier, ...slow },
      { date: later, count: 3, avgMs: 220 / 3, minMs: 20, maxMs: 120, p95Ms: 120 },
    ]);
    expect(aggregates.daily).toEqual([
      { date: earlier, tokens: 5, cost: 6, messages: 0, toolCalls: 0, errors: 0 },
      { date: later, tokens: 10, cost: 12, messages: 9, toolCalls: 2, errors: 1 },
    ]);
    expect(aggregates.modelDaily?.map(({ date, model }) => [date, model])).toEqual([
      [earlier, "one"],
      [later, "two"],
      [later, "one"],
    ]);
  });

  it("keeps empty reports and zero-count latency free of nonfinite values", () => {
    const accumulator = createUsageAggregateAccumulator();
    accumulator.add({ usage: null });
    expect(accumulator.finish()).toEqual({
      sessionCount: 0,
      messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byModel: [],
      byProvider: [],
      byAgent: [],
      byChannel: [],
      latency: undefined,
      dailyLatency: [],
      modelDaily: [],
      daily: [],
    });
    accumulator.add({
      usage: usage({
        latency: { count: 0, avgMs: 999, minMs: 1, maxMs: 999, p95Ms: 999 },
        dailyLatency: [
          {
            date: "2026-03-12",
            count: 0,
            avgMs: 0,
            minMs: Number.POSITIVE_INFINITY,
            maxMs: 0,
            p95Ms: 0,
          },
        ],
      }),
    });
    const aggregates = accumulator.finish();
    expect(aggregates.latency).toBeUndefined();
    expect(aggregates.dailyLatency).toEqual([
      { date: "2026-03-12", count: 0, avgMs: 0, minMs: 0, maxMs: 0, p95Ms: 0 },
    ]);
  });
});

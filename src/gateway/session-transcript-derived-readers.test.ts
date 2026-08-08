import { describe, expect, test } from "vitest";
import { aggregateSqliteUsageSnapshots } from "./session-transcript-derived-readers.js";

const CUMULATIVE_RUN_USAGE = {
  input: 285_000,
  output: 1_200,
  cacheRead: 214_656,
  cacheWrite: 0,
  total: 500_856,
} as const;

const UNAVAILABLE_CONTEXT_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  contextUsage: { state: "unavailable" },
} as const;

const PER_CALL_USAGE = {
  input: 12_000,
  output: 800,
  total: 12_800,
} as const;

function assistantMessage(usage: Record<string, unknown>) {
  return {
    role: "assistant",
    provider: "minimax",
    model: "Minimax-M3",
    usage,
  };
}

describe("aggregateSqliteUsageSnapshots", () => {
  test("retires an earlier cumulative total when an unavailable context marker arrives", () => {
    const aggregate = aggregateSqliteUsageSnapshots([
      assistantMessage(CUMULATIVE_RUN_USAGE),
      assistantMessage(UNAVAILABLE_CONTEXT_USAGE),
    ]);

    expect(aggregate).not.toBeNull();
    expect(aggregate?.totalTokens).toBeUndefined();
    expect(aggregate?.totalTokensFresh).toBeUndefined();
    expect(aggregate?.contextUsage).toEqual({ state: "unavailable" });
  });

  test("restores a fresh total when valid per-call usage follows an unavailable marker", () => {
    const aggregate = aggregateSqliteUsageSnapshots([
      assistantMessage(CUMULATIVE_RUN_USAGE),
      assistantMessage(UNAVAILABLE_CONTEXT_USAGE),
      assistantMessage(PER_CALL_USAGE),
    ]);

    expect(aggregate).toMatchObject({
      totalTokens: 12_000,
      totalTokensFresh: true,
    });
    expect(aggregate?.contextUsage).toBeUndefined();
  });

  test("keeps the latest numeric total when no unavailable marker is present", () => {
    const aggregate = aggregateSqliteUsageSnapshots([
      assistantMessage(CUMULATIVE_RUN_USAGE),
      assistantMessage(PER_CALL_USAGE),
    ]);

    expect(aggregate).toMatchObject({
      totalTokens: 12_000,
      totalTokensFresh: true,
    });
  });
});

// Usage accumulator tests cover multi-call token aggregation used for billing
// metadata on embedded run results.
import { describe, expect, it } from "vitest";
import {
  createUsageAccumulator,
  mergeAttemptRunStatsIntoAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "./usage-accumulator.js";

type UsageInput = NonNullable<Parameters<typeof mergeUsageIntoAccumulator>[1]>;

const FIRST_USAGE: UsageInput = {
  input: 100,
  output: 50,
  reasoningTokens: 12,
  cacheRead: 80_000,
  cacheWrite: 5_000,
  cacheWrite1h: 3_000,
  total: 85_150,
};

const SECOND_USAGE: UsageInput = {
  input: 120,
  output: 30,
  cacheRead: 82_000,
  cacheWrite: 0,
  total: 82_150,
};

const FINAL_USAGE: UsageInput = {
  input: 150,
  output: 40,
  reasoningTokens: 7,
  cacheRead: 84_000,
  cacheWrite: 0,
  contextUsage: {
    state: "available",
    promptTokens: 84_150,
    totalTokens: 84_190,
  },
  total: 84_190,
};

function createAccumulatorWithUsage(...usages: UsageInput[]) {
  // Helper feeds usage snapshots in order so tests can distinguish accumulated
  // totals from the exact final provider call.
  const acc = createUsageAccumulator();
  for (const usage of usages) {
    mergeUsageIntoAccumulator(acc, usage);
  }
  return acc;
}

describe("usage-accumulator", () => {
  describe("mergeUsageIntoAccumulator", () => {
    it("accumulates usage across multiple API calls", () => {
      const acc = createAccumulatorWithUsage(FIRST_USAGE, SECOND_USAGE, FINAL_USAGE);

      expect(acc.input).toBe(370);
      expect(acc.output).toBe(120);
      expect(acc.reasoningTokens).toBe(19);
      expect(acc.cacheRead).toBe(246_000);
      expect(acc.cacheWrite).toBe(5_000);
      expect(toNormalizedUsage(acc)).toMatchObject({ cacheWrite1h: 3_000 });
      expect(acc.total).toBe(251_490);
    });

    it.each([
      { name: "all priced calls", costs: [0.125, 0.25], expected: { total: 0.375 } },
      { name: "explicit zero prices", costs: [0, 0], expected: { total: 0 } },
      { name: "missing later price", costs: [0.125, undefined], expected: undefined },
      { name: "missing earlier price", costs: [undefined, 0.125], expected: undefined },
    ])("carries only complete cost for $name", ({ costs, expected }) => {
      const acc = createAccumulatorWithUsage(
        ...costs.map((total) => ({
          input: 150_000,
          output: 100,
          ...(total !== undefined ? { cost: { total } } : {}),
        })),
      );

      expect(toNormalizedUsage(acc)).toMatchObject({ input: 300_000, output: 200 });
      expect(toNormalizedUsage(acc)?.cost).toEqual(expected);
    });

    it("carries complete costs across attempts without claiming provider provenance", () => {
      const firstAttempt = createAccumulatorWithUsage({
        input: 150_000,
        cost: { total: 0.125, totalOrigin: "provider-billed" },
      });
      const secondAttempt = createAccumulatorWithUsage({ input: 150_000, cost: { total: 0.5 } });
      const run = createUsageAccumulator();
      mergeUsageIntoAccumulator(run, toNormalizedUsage(firstAttempt));
      mergeUsageIntoAccumulator(run, toNormalizedUsage(secondAttempt));

      expect(toNormalizedUsage(run)?.cost).toEqual({ total: 0.625 });
      mergeUsageIntoAccumulator(run, { input: 1 });
      expect(toNormalizedUsage(run)?.cost).toBeUndefined();
    });

    it("ignores undefined or zero-only usage", () => {
      const acc = createUsageAccumulator();

      mergeUsageIntoAccumulator(acc, undefined);
      mergeUsageIntoAccumulator(acc, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      });

      expect(acc).toEqual(createUsageAccumulator());
    });
  });

  describe("mergeAttemptRunStatsIntoAccumulator", () => {
    it("accumulates turns and bridge calls across retry/fallback attempts", () => {
      const acc = createUsageAccumulator();

      // First attempt makes bridge calls, then a retry/fallback attempt runs.
      mergeAttemptRunStatsIntoAccumulator(acc, {
        assistantTurns: 2,
        bridgeCalls: { search: 1, describe: 2, call: 3 },
      });
      mergeAttemptRunStatsIntoAccumulator(acc, {
        assistantTurns: 1,
        bridgeCalls: { search: 0, describe: 1, call: 4 },
      });

      expect(acc.assistantTurns).toBe(3);
      expect(acc.bridgeCalls).toEqual({ search: 1, describe: 3, call: 7 });
    });

    it("keeps bridgeCalls absent for catalog-less attempts", () => {
      const acc = createUsageAccumulator();

      mergeAttemptRunStatsIntoAccumulator(acc, { assistantTurns: 1 });

      expect(acc.assistantTurns).toBe(1);
      expect(acc.bridgeCalls).toBeUndefined();
    });
  });

  describe("toNormalizedUsage", () => {
    it("returns undefined for an empty accumulator", () => {
      expect(toNormalizedUsage(createUsageAccumulator())).toBeUndefined();
    });

    it("returns accumulated totals for billing", () => {
      const acc = createUsageAccumulator();

      mergeUsageIntoAccumulator(acc, {
        input: 100,
        output: 50,
        reasoningTokens: 4,
        cacheRead: 80_000,
        cacheWrite: 5_000,
      });
      mergeUsageIntoAccumulator(acc, {
        input: 120,
        output: 30,
        cacheRead: 82_000,
        cacheWrite: 0,
      });
      mergeUsageIntoAccumulator(acc, {
        input: 150,
        output: 40,
        cacheRead: 84_000,
        cacheWrite: 0,
      });

      expect(toNormalizedUsage(acc)).toEqual({
        input: 370,
        output: 120,
        reasoningTokens: 4,
        cacheRead: 246_000,
        cacheWrite: 5_000,
        total: 251_490,
      });
    });

    it("omits zero fields", () => {
      const acc = createUsageAccumulator();
      mergeUsageIntoAccumulator(acc, { input: 100, output: 50 });

      expect(toNormalizedUsage(acc)).toEqual({
        input: 100,
        output: 50,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: 150,
      });
    });
  });
});

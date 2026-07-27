// Usage accumulator tests cover multi-call token aggregation used for billing
// metadata on embedded run results.
import { describe, expect, it } from "vitest";
import {
  createUsageAccumulator,
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
      expect(acc.total).toBe(251_490);
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

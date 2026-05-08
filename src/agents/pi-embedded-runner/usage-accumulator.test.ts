import { describe, expect, it } from "vitest";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  resolveLastCallUsage,
  toLastCallUsage,
  toNormalizedUsage,
} from "./usage-accumulator.js";

type UsageInput = NonNullable<Parameters<typeof mergeUsageIntoAccumulator>[1]>;

const FIRST_USAGE: UsageInput = {
  input: 100,
  output: 50,
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
  cacheRead: 84_000,
  cacheWrite: 0,
  total: 84_190,
};

function createAccumulatorWithUsage(...usages: UsageInput[]) {
  const acc = createUsageAccumulator();
  for (const usage of usages) {
    mergeUsageIntoAccumulator(acc, usage);
  }
  return acc;
}

const emptyAccumulatorCases = [
  { name: "toNormalizedUsage", resolve: toNormalizedUsage },
  { name: "toLastCallUsage", resolve: toLastCallUsage },
];

describe("usage-accumulator", () => {
  describe("mergeUsageIntoAccumulator", () => {
    it("accumulates usage across multiple API calls", () => {
      const acc = createAccumulatorWithUsage(FIRST_USAGE, SECOND_USAGE, FINAL_USAGE);

      expect(acc.input).toBe(370);
      expect(acc.output).toBe(120);
      expect(acc.cacheRead).toBe(246_000);
      expect(acc.cacheWrite).toBe(5_000);
      expect(acc.total).toBe(251_490);
    });

    it("stores the exact final call snapshot", () => {
      const acc = createAccumulatorWithUsage(FIRST_USAGE, FINAL_USAGE);

      expect(acc.lastInput).toBe(150);
      expect(acc.lastOutput).toBe(40);
      expect(acc.lastCacheRead).toBe(84_000);
      expect(acc.lastCacheWrite).toBe(0);
      expect(acc.lastTotal).toBe(84_190);
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

  describe("empty accumulator", () => {
    it.each(emptyAccumulatorCases)(
      "$name returns undefined for an empty accumulator",
      ({ resolve }) => {
        expect(resolve(createUsageAccumulator())).toBeUndefined();
      },
    );
  });

  describe("toNormalizedUsage", () => {
    it("returns accumulated totals for billing", () => {
      const acc = createUsageAccumulator();

      mergeUsageIntoAccumulator(acc, {
        input: 100,
        output: 50,
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

  describe("toLastCallUsage", () => {
    it("returns the exact final call snapshot", () => {
      const acc = createAccumulatorWithUsage(FIRST_USAGE, FINAL_USAGE);

      expect(toLastCallUsage(acc)).toEqual({
        input: 150,
        output: 40,
        cacheRead: 84_000,
        cacheWrite: undefined,
        total: 84_190,
      });
    });
  });

  describe("resolveLastCallUsage", () => {
    it("prefers raw assistant usage when present", () => {
      const acc = createUsageAccumulator();
      mergeUsageIntoAccumulator(acc, {
        input: 150,
        output: 40,
        cacheRead: 84_000,
        cacheWrite: 0,
        total: 84_190,
      });

      expect(
        resolveLastCallUsage(
          {
            inputTokens: 99,
            outputTokens: 12,
            cache_read_input_tokens: 456,
            cache_creation_input_tokens: 3,
            totalTokens: 570,
          },
          acc,
        ),
      ).toEqual({
        input: 99,
        output: 12,
        cacheRead: 456,
        cacheWrite: 3,
        total: 570,
      });
    });

    it("falls back to the accumulator when assistant usage is missing", () => {
      const acc = createAccumulatorWithUsage(FINAL_USAGE);

      expect(resolveLastCallUsage(undefined, acc)).toEqual({
        input: 150,
        output: 40,
        cacheRead: 84_000,
        cacheWrite: undefined,
        total: 84_190,
      });
    });

    it("falls back when assistant usage exists but is unusable", () => {
      const acc = createAccumulatorWithUsage(FINAL_USAGE);

      expect(resolveLastCallUsage({ responseId: "abc" } as never, acc)).toEqual({
        input: 150,
        output: 40,
        cacheRead: 84_000,
        cacheWrite: undefined,
        total: 84_190,
      });
    });

    it("keeps an explicit zero-usage raw snapshot instead of falling back", () => {
      const acc = createAccumulatorWithUsage(FINAL_USAGE);

      expect(
        resolveLastCallUsage(
          {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
          acc,
        ),
      ).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      });
    });
  });
});

// Usage accumulator tests cover multi-call token aggregation used for billing
// metadata on embedded run results.
import { describe, expect, it } from "vitest";
import { createCodeModeStats, recordCodeModeSnapshot } from "../code-mode-stats.js";
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

    it("accumulates detailed Code Mode stats across attempts", () => {
      const acc = createUsageAccumulator();
      const first = createCodeModeStats();
      first.controlCalls.exec = 1;
      first.bridgeCalls.callValue = 2;
      first.bridgeLifecycle.registered = 2;
      first.bridgeLifecycle.settled = 2;
      first.bridgeLifecycle.unresolvedAtExtraction = 2;
      first.workerRuns.exec = { count: 1, elapsedMs: 10 };
      first.outcomes.completed = 1;
      recordCodeModeSnapshot(first, {
        disposition: "accepted",
        measurement: { bytes: 8, serializationMs: 2 },
        coverage: "exact",
      });
      const second = createCodeModeStats();
      second.controlCalls.exec = 1;
      second.controlCalls.wait = 1;
      second.bridgeCalls.agentWait = 1;
      second.bridgeLifecycle.registered = 1;
      second.bridgeLifecycle.unresolvedAtExtraction = 1;
      second.workerRuns.exec = { count: 1, elapsedMs: 5 };
      second.workerRuns.resume = { count: 1, elapsedMs: 7 };
      second.outcomes.waiting = 1;
      recordCodeModeSnapshot(second, {
        disposition: "incomplete",
        coverage: "lower_bound",
      });

      mergeAttemptRunStatsIntoAccumulator(acc, { codeModeStats: first });
      mergeAttemptRunStatsIntoAccumulator(acc, { codeModeStats: second });

      expect(acc.codeModeStats).toMatchObject({
        controlCalls: { exec: 2, wait: 1 },
        bridgeCalls: { callValue: 2, agentWait: 1 },
        workerRuns: {
          exec: { count: 2, elapsedMs: 15 },
          resume: { count: 1, elapsedMs: 7 },
        },
        bridgeLifecycle: { registered: 3, settled: 2, unresolvedAtExtraction: 1 },
        snapshots: {
          attempted: 2,
          produced: 1,
          accepted: 1,
          rejected: 0,
          incomplete: 1,
          totalBytes: 8,
          maxBytes: 8,
          serializationMs: 2,
          coverage: "lower_bound",
        },
        outcomes: { completed: 1, waiting: 1 },
      });
    });

    it.each([
      { label: "omitted sparse zero", next: undefined },
      { label: "explicit zero", next: 0 },
    ])("clears a prior unresolved gauge with $label", ({ next }) => {
      const acc = createUsageAccumulator();
      const first = createCodeModeStats();
      first.bridgeLifecycle.unresolvedAtExtraction = 1;
      const second = createCodeModeStats();
      if (next !== undefined) {
        second.bridgeLifecycle.unresolvedAtExtraction = next;
      }

      mergeAttemptRunStatsIntoAccumulator(acc, { codeModeStats: first });
      mergeAttemptRunStatsIntoAccumulator(acc, { codeModeStats: second });

      expect(acc.codeModeStats?.bridgeLifecycle.unresolvedAtExtraction).toBe(next);
    });

    it("clears a prior unresolved gauge on a non-Code fallback attempt", () => {
      const acc = createUsageAccumulator();
      const first = createCodeModeStats();
      first.bridgeLifecycle.registered = 1;
      first.bridgeLifecycle.unresolvedAtExtraction = 1;

      mergeAttemptRunStatsIntoAccumulator(acc, { codeModeStats: first });
      mergeAttemptRunStatsIntoAccumulator(acc, { assistantTurns: 1 });

      expect(acc.codeModeStats?.bridgeLifecycle).toEqual({ registered: 1 });
      expect(acc.assistantTurns).toBe(1);
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

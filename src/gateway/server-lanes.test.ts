/**
 * Gateway server lane configuration tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueCommandInLane, resetCommandQueueStateForTest } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { createDeferred } from "./test-helpers.deferred.js";

describe("applyGatewayLaneConcurrency", () => {
  afterEach(() => {
    resetCommandQueueStateForTest();
  });

  it("uses the higher cron default when maxConcurrentRuns is unset", async () => {
    applyGatewayLaneConcurrency({} as OpenClawConfig);

    let activeRuns = 0;
    let peakActiveRuns = 0;
    const allRunsStarted = createDeferred();
    const releaseRuns = createDeferred();

    const run = async () => {
      activeRuns += 1;
      peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
      if (peakActiveRuns >= DEFAULT_CRON_MAX_CONCURRENT_RUNS) {
        allRunsStarted.resolve();
      }
      try {
        await releaseRuns.promise;
      } finally {
        activeRuns -= 1;
      }
    };

    const runs = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () =>
      enqueueCommandInLane(CommandLane.CronNested, run, { warnAfterMs: 10_000 }),
    );
    const timeout = setTimeout(() => {
      allRunsStarted.reject(new Error("timed out waiting for default cron concurrency"));
    }, 250);

    try {
      await allRunsStarted.promise;
      expect(peakActiveRuns).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);
    } finally {
      clearTimeout(timeout);
      releaseRuns.resolve();
      await Promise.all(runs);
    }
  });

  it("applies cron maxConcurrentRuns to the cron-nested lane used by cron agent turns", async () => {
    applyGatewayLaneConcurrency({ cron: { maxConcurrentRuns: 2 } } as OpenClawConfig);

    let activeRuns = 0;
    let peakActiveRuns = 0;
    const bothRunsStarted = createDeferred();
    const releaseRuns = createDeferred();

    const run = async () => {
      activeRuns += 1;
      peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
      if (peakActiveRuns >= 2) {
        bothRunsStarted.resolve();
      }
      try {
        await releaseRuns.promise;
      } finally {
        activeRuns -= 1;
      }
    };

    const first = enqueueCommandInLane(CommandLane.CronNested, run, { warnAfterMs: 10_000 });
    const second = enqueueCommandInLane(CommandLane.CronNested, run, { warnAfterMs: 10_000 });
    const timeout = setTimeout(() => {
      bothRunsStarted.reject(
        new Error("timed out waiting for nested cron work to run in parallel"),
      );
    }, 250);

    try {
      await bothRunsStarted.promise;
      expect(peakActiveRuns).toBe(2);
    } finally {
      clearTimeout(timeout);
      releaseRuns.resolve();
      await Promise.all([first, second]);
    }
  });

  it("keeps the shared nested lane at its default concurrency", async () => {
    applyGatewayLaneConcurrency({ cron: { maxConcurrentRuns: 2 } } as OpenClawConfig);

    let startedRuns = 0;
    const releaseRuns = createDeferred();
    const run = async () => {
      startedRuns += 1;
      await releaseRuns.promise;
    };

    const first = enqueueCommandInLane(CommandLane.Nested, run, { warnAfterMs: 10_000 });
    const second = enqueueCommandInLane(CommandLane.Nested, run, { warnAfterMs: 10_000 });
    await Promise.resolve();

    expect(startedRuns).toBe(1);

    releaseRuns.resolve();
    await Promise.all([first, second]);
  });
});

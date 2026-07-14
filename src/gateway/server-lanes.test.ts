/**
 * Gateway server lane configuration tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  enqueueCommandInLane,
  resetCommandQueueStateForTest,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { createDeferred } from "../test-utils/deferred.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "./server-lanes.js";

function applyConfigLaneConcurrency(
  config: OpenClawConfig,
  opts: { gatewayStart?: boolean } = {},
): void {
  applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(config), opts);
}

describe("applyGatewayLaneConcurrency", () => {
  afterEach(async () => {
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
      vi.clearAllTimers();
    }
    vi.useRealTimers();
    // Gateway startup drains the process-global suspension cleanup state.
    // Reset between tests so lane assertions only see this test's setup.
    const { testing } = await import("../agents/session-suspension.js");
    testing.resetSessionSuspensionStateForTest();
    resetCommandQueueStateForTest();
  });

  it("uses the higher cron default when maxConcurrentRuns is unset", async () => {
    applyConfigLaneConcurrency({} as OpenClawConfig);

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
    applyConfigLaneConcurrency({ cron: { maxConcurrentRuns: 2 } } as OpenClawConfig);

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
    applyConfigLaneConcurrency({ cron: { maxConcurrentRuns: 2 } } as OpenClawConfig, {
      gatewayStart: true,
    });

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

  it("restores a suspended shared nested lane on gateway startup", async () => {
    setCommandLaneConcurrency(CommandLane.Nested, 0);
    applyConfigLaneConcurrency({} as OpenClawConfig, { gatewayStart: true });

    let started = false;
    await enqueueCommandInLane(
      CommandLane.Nested,
      async () => {
        started = true;
      },
      { warnAfterMs: 10_000 },
    );

    expect(started).toBe(true);
  });

  it("does not resume a suspended shared nested lane during live config publication", async () => {
    setCommandLaneConcurrency(CommandLane.Nested, 0);
    applyConfigLaneConcurrency({} as OpenClawConfig);

    let started = false;
    const nestedRun = enqueueCommandInLane(
      CommandLane.Nested,
      async () => {
        started = true;
      },
      { warnAfterMs: 10_000 },
    );
    await Promise.resolve();

    expect(started).toBe(false);

    setCommandLaneConcurrency(CommandLane.Nested, 1);
    await nestedRun;
    expect(started).toBe(true);
  });

  it("does not resume cleanup-held built-in lanes during live config publication", async () => {
    const { testing } = await import("../agents/session-suspension.js");
    testing.seedClearedLaneResumeForTest(CommandLane.Main, {
      resumeConcurrency: 3,
      resumeAtMs: Date.now() + 100,
    });
    setCommandLaneConcurrency(CommandLane.Main, 0);

    applyConfigLaneConcurrency({ agents: { defaults: { maxConcurrent: 3 } } } as OpenClawConfig);

    let started = false;
    const mainRun = enqueueCommandInLane(
      CommandLane.Main,
      async () => {
        started = true;
      },
      { warnAfterMs: 10_000 },
    );
    await Promise.resolve();

    expect(started).toBe(false);

    setCommandLaneConcurrency(CommandLane.Main, 1);
    await mainRun;
    expect(started).toBe(true);
  });

  it("does not resume an unexpired shared nested lane during gateway startup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { testing } = await import("../agents/session-suspension.js");
    testing.seedClearedLaneResumeForTest(CommandLane.Nested, {
      resumeConcurrency: 1,
      resumeAtMs: 1_100,
    });
    setCommandLaneConcurrency(CommandLane.Nested, 0);

    applyConfigLaneConcurrency({} as OpenClawConfig, { gatewayStart: true });

    let started = false;
    const nestedRun = enqueueCommandInLane(
      CommandLane.Nested,
      async () => {
        started = true;
      },
      { warnAfterMs: 10_000 },
    );
    await Promise.resolve();

    expect(started).toBe(false);

    await vi.advanceTimersByTimeAsync(99);
    expect(started).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await nestedRun;
    expect(started).toBe(true);
  });
});

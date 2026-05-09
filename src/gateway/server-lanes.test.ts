import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueCommandInLane, resetCommandQueueStateForTest } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

describe("applyGatewayLaneConcurrency", () => {
  afterEach(() => {
    resetCommandQueueStateForTest();
  });

  it("applies cron maxConcurrentRuns to the cron-nested lane used by cron agent turns", async () => {
    applyGatewayLaneConcurrency({ cron: { maxConcurrentRuns: 2 } } as OpenClawConfig);

    let activeRuns = 0;
    let peakActiveRuns = 0;
    const bothRunsStarted = createDeferred<void>();
    const releaseRuns = createDeferred<void>();

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
    const releaseRuns = createDeferred<void>();
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

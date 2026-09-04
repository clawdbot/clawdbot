/**
 * Gateway server lane configuration tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createBackgroundWorkOwner,
  getBackgroundWorkSnapshot,
} from "../process/background-work.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";
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
    const { resetSessionSuspensionStateForTest } =
      await import("../agents/session-suspension.test-support.js");
    resetSessionSuspensionStateForTest();
    resetCommandQueueStateForTest();
  });

  it("uses the built-in cron concurrency", async () => {
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

  it("keeps the shared nested lane at its default concurrency", async () => {
    applyConfigLaneConcurrency({} as OpenClawConfig, { gatewayStart: true });

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

  it("preserves shared background capacity across gateway lane publication", async () => {
    const owner = createBackgroundWorkOwner({ owner: "plugin:reload-test", maxConcurrent: 3 });
    const gates = Array.from({ length: 3 }, () => createDeferred());
    const active = gates.map((gate) => owner.enqueue(async () => await gate.promise));
    let nextStarted = false;
    const next = owner.enqueue(async () => {
      nextStarted = true;
    });
    try {
      applyConfigLaneConcurrency({ hooks: { enabled: true } });
      applyConfigLaneConcurrency({ hooks: { enabled: false } });
      expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 3, queuedCount: 1 });
      expect(nextStarted).toBe(false);
    } finally {
      gates.forEach((gate) => gate.resolve());
      await Promise.all([...active, next]);
    }
    expect(nextStarted).toBe(true);
  });
});

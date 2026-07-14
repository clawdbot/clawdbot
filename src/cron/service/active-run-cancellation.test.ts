import { describe, expect, it, vi } from "vitest";
import {
  CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS,
  getSuspensionVisibleCronTaskRunCount,
  resetActiveCronTaskRunsForTests,
  retireActiveCronTaskRunTracking,
  startActiveCronTaskRunSettlementGrace,
  trackActiveCronTaskRunSettlement,
  waitForActiveCronTaskRuns,
} from "./active-run-cancellation.js";

describe("cron task cancellation tracking", () => {
  it("retires restart tracking while keeping an unsettled core suspension-visible", async () => {
    resetActiveCronTaskRunsForTests();
    let settle = () => {};
    const core = new Promise<void>((resolve) => {
      settle = resolve;
    });
    trackActiveCronTaskRunSettlement(core);

    await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
      drained: false,
      active: 1,
    });
    expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);

    retireActiveCronTaskRunTracking();

    await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
      drained: true,
      active: 0,
    });
    expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);

    settle();
    await core;
    await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
  });

  it("drops never-settling cron promises after a bounded grace period", async () => {
    vi.useFakeTimers();
    try {
      resetActiveCronTaskRunsForTests();
      trackActiveCronTaskRunSettlement(new Promise<never>(() => {}));

      await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
        drained: false,
        active: 1,
      });

      await vi.advanceTimersByTimeAsync(CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS + 1);

      await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
        drained: false,
        active: 1,
      });

      startActiveCronTaskRunSettlementGrace();
      await vi.advanceTimersByTimeAsync(CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS + 1);

      await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
        drained: true,
        active: 0,
      });
      expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);
    } finally {
      vi.useRealTimers();
      resetActiveCronTaskRunsForTests();
    }
  });

  it("keeps suspension blocked until a timed-out core actually settles", async () => {
    resetActiveCronTaskRunsForTests();
    let settle = () => {};
    const core = new Promise<void>((resolve) => {
      settle = resolve;
    });
    trackActiveCronTaskRunSettlement(core);
    startActiveCronTaskRunSettlementGrace();

    expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);
    settle();
    await core;
    await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
  });
});

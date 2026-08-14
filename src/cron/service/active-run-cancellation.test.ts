import { describe, expect, it, vi } from "vitest";
import { clearCronJobActive, markCronJobActive, noteActiveCronJobRemoval } from "../active-jobs.js";
import {
  abortActiveCronTaskRuns,
  cancelActiveCronTaskRun,
  getSuspensionVisibleCronTaskRunCount,
  registerActiveCronTaskRun,
  retireActiveCronTaskRunTracking,
  trackActiveCronTaskRunSettlement,
  waitForActiveCronTaskRuns,
} from "./active-run-cancellation.js";
import { resetActiveCronTaskRunsForTests } from "./active-run-cancellation.test-support.js";

const CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS = 60_000;

describe("cron task cancellation tracking", () => {
  it("consumes a removal request made before the run controller binds", () => {
    const marker = markCronJobActive("removed-before-controller");
    const controller = new AbortController();
    noteActiveCronJobRemoval("removed-before-controller");

    const release = registerActiveCronTaskRun({
      runId: "removed-before-controller-run",
      controller,
      activeJobMarker: marker,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("Cron job removed by operator.");
    release?.();
    clearCronJobActive("removed-before-controller", marker);
  });

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

  it.each([
    { timing: "after tracking", abortBeforeTracking: false },
    { timing: "before tracking", abortBeforeTracking: true },
  ])(
    "drops never-settling cron promises after an abort $timing",
    async ({ abortBeforeTracking }) => {
      vi.useFakeTimers();
      try {
        resetActiveCronTaskRunsForTests();
        const controller = new AbortController();
        if (abortBeforeTracking) {
          controller.abort();
        }
        trackActiveCronTaskRunSettlement(new Promise<never>(() => {}), controller.signal);

        await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
          drained: false,
          active: 1,
        });

        if (!abortBeforeTracking) {
          await vi.advanceTimersByTimeAsync(CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS + 1);

          await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
            drained: false,
            active: 1,
          });

          controller.abort();
        }
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
    },
  );

  it("does not retire an unrelated active run when one registered run is cancelled", async () => {
    vi.useFakeTimers();
    const cancelledController = new AbortController();
    const unaffectedController = new AbortController();
    let settleCancelled = () => {};
    let settleUnaffected = () => {};
    const cancelledRun = new Promise<void>((resolve) => {
      settleCancelled = resolve;
    });
    const unaffectedRun = new Promise<void>((resolve) => {
      settleUnaffected = resolve;
    });

    try {
      resetActiveCronTaskRunsForTests();
      trackActiveCronTaskRunSettlement(cancelledRun, cancelledController.signal);
      trackActiveCronTaskRunSettlement(unaffectedRun, unaffectedController.signal);
      const release = registerActiveCronTaskRun({
        runId: "cancelled-run",
        controller: cancelledController,
      });
      const existingTimerCount = vi.getTimerCount();

      expect(cancelActiveCronTaskRun({ runId: "cancelled-run" })).toBe(true);
      expect(vi.getTimerCount()).toBe(existingTimerCount + 1);
      expect(cancelActiveCronTaskRun({ runId: "cancelled-run" })).toBe(false);
      release?.();

      await vi.advanceTimersByTimeAsync(CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS + 1);

      await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
        drained: false,
        active: 1,
      });
      expect(getSuspensionVisibleCronTaskRunCount()).toBe(2);
    } finally {
      settleCancelled();
      settleUnaffected();
      await Promise.all([cancelledRun, unaffectedRun]);
      vi.useRealTimers();
      resetActiveCronTaskRunsForTests();
    }
  });

  it.each([
    { scenario: "only handleless runs", cancellableRuns: 0, handlelessRuns: 1 },
    { scenario: "mixed active runs", cancellableRuns: 1, handlelessRuns: 1 },
    { scenario: "no active runs", cancellableRuns: 0, handlelessRuns: 0 },
  ])("retires $scenario during a bulk shutdown", async ({ cancellableRuns, handlelessRuns }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      resetActiveCronTaskRunsForTests();
      if (cancellableRuns > 0) {
        trackActiveCronTaskRunSettlement(new Promise<never>(() => {}), controller.signal);
      }
      if (handlelessRuns > 0) {
        trackActiveCronTaskRunSettlement(new Promise<never>(() => {}));
      }
      const release =
        cancellableRuns > 0
          ? registerActiveCronTaskRun({ runId: "shutdown-run", controller })
          : undefined;

      expect(abortActiveCronTaskRuns()).toBe(cancellableRuns);
      const retirementTimerCount = vi.getTimerCount();
      expect(abortActiveCronTaskRuns()).toBe(0);
      expect(vi.getTimerCount()).toBe(retirementTimerCount);
      if (cancellableRuns + handlelessRuns === 0) {
        expect(retirementTimerCount).toBe(0);
      }
      release?.();
      await vi.advanceTimersByTimeAsync(CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS + 1);

      await expect(waitForActiveCronTaskRuns(0)).resolves.toEqual({
        drained: true,
        active: 0,
      });
      expect(getSuspensionVisibleCronTaskRunCount()).toBe(cancellableRuns + handlelessRuns);
    } finally {
      vi.useRealTimers();
      resetActiveCronTaskRunsForTests();
    }
  });

  it("keeps suspension blocked until a timed-out core actually settles", async () => {
    resetActiveCronTaskRunsForTests();
    const controller = new AbortController();
    let settle = () => {};
    const core = new Promise<void>((resolve) => {
      settle = resolve;
    });
    trackActiveCronTaskRunSettlement(core, controller.signal);
    controller.abort();

    expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);
    settle();
    await core;
    await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
  });
});

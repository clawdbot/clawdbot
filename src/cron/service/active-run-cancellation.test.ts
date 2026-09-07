import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
  it("keeps a removed agent's unsettled core visible after cancellation and restart retirement", async () => {
    vi.useFakeTimers();
    resetActiveCronTaskRunsForTests();
    const removed = createDeferred();
    const survivor = createDeferred();
    const controller = new AbortController();
    trackActiveCronTaskRunSettlement(removed.promise, controller.signal, "removed");
    trackActiveCronTaskRunSettlement(survivor.promise, undefined, "survivor");
    try {
      controller.abort();
      await vi.advanceTimersByTimeAsync(CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS + 1);
      retireActiveCronTaskRunTracking();
      expect(getSuspensionVisibleCronTaskRunCount({ agentId: "removed" })).toBe(1);
      removed.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(getSuspensionVisibleCronTaskRunCount({ agentId: "removed" })).toBe(0);
      expect(getSuspensionVisibleCronTaskRunCount({ agentId: "survivor" })).toBe(1);
    } finally {
      removed.resolve();
      survivor.resolve();
      await Promise.allSettled([removed.promise, survivor.promise]);
      vi.useRealTimers();
      resetActiveCronTaskRunsForTests();
    }
  });

  it("consumes a removal request made before the run controller binds", () => {
    const marker = markCronJobActive("removed-before-controller");
    const controller = new AbortController();
    noteActiveCronJobRemoval("removed-before-controller");

    const release = registerActiveCronTaskRun({
      runId: "removed-before-controller-run",
      controller,
      activeJobMarker: marker,
    });

    try {
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe("Cron job removed by operator.");
    } finally {
      release?.();
      clearCronJobActive("removed-before-controller", marker);
    }
  });

  it("retires restart tracking while keeping an unsettled core suspension-visible", async () => {
    resetActiveCronTaskRunsForTests();
    const core = createDeferred();
    trackActiveCronTaskRunSettlement(core.promise);

    try {
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

      core.resolve();
      await core.promise;
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    } finally {
      core.resolve();
      await core.promise;
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    }
  });

  it.each([
    { direction: "backward", clockShiftMs: -86_400_000 },
    { direction: "forward", clockShiftMs: 86_400_000 },
  ])(
    "keeps shutdown drain deadlines stable when the wall clock jumps $direction",
    async ({ clockShiftMs }) => {
      vi.useFakeTimers();
      resetActiveCronTaskRunsForTests();
      const initialWallTimeMs = Date.parse("2026-08-23T12:00:00.000Z");
      vi.setSystemTime(initialWallTimeMs);
      const core = createDeferred();
      trackActiveCronTaskRunSettlement(core.promise);
      const observedDrain = vi.fn();
      const drain = waitForActiveCronTaskRuns(1_000).then(observedDrain);

      try {
        vi.setSystemTime(initialWallTimeMs + clockShiftMs);
        await vi.advanceTimersByTimeAsync(999);
        expect(observedDrain).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(observedDrain).toHaveBeenCalledExactlyOnceWith({ drained: false, active: 1 });
      } finally {
        core.resolve();
        await Promise.allSettled([core.promise, drain]);
        await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
        resetActiveCronTaskRunsForTests();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { lifecycle: "registered cancellation handle", settleCore: false },
    { lifecycle: "tracked executing core", settleCore: true },
  ])(
    "releases concurrent shutdown drains as soon as the final $lifecycle settles",
    async ({ settleCore }) => {
      vi.useFakeTimers();
      resetActiveCronTaskRunsForTests();
      const core = createDeferred();
      const release = settleCore
        ? undefined
        : registerActiveCronTaskRun({
            runId: "draining-handle",
            controller: new AbortController(),
          });
      if (settleCore) {
        trackActiveCronTaskRunSettlement(core.promise);
      }
      const firstObservedDrain = vi.fn();
      const secondObservedDrain = vi.fn();
      const drains = Promise.all([
        waitForActiveCronTaskRuns(1_000).then(firstObservedDrain),
        waitForActiveCronTaskRuns(2_000).then(secondObservedDrain),
      ]);

      try {
        if (settleCore) {
          core.resolve();
        } else {
          release?.();
        }
        await vi.advanceTimersByTimeAsync(1);

        expect(firstObservedDrain).toHaveBeenCalledExactlyOnceWith({ drained: true, active: 0 });
        expect(secondObservedDrain).toHaveBeenCalledExactlyOnceWith({ drained: true, active: 0 });
      } finally {
        core.resolve();
        release?.();
        await Promise.allSettled([core.promise, drains]);
        await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
        resetActiveCronTaskRunsForTests();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { timing: "after tracking", abortBeforeTracking: false },
    { timing: "before tracking", abortBeforeTracking: true },
  ])(
    "drops never-settling cron promises after an abort $timing",
    async ({ abortBeforeTracking }) => {
      vi.useFakeTimers();
      const core = createDeferred();
      try {
        resetActiveCronTaskRunsForTests();
        const controller = new AbortController();
        if (abortBeforeTracking) {
          controller.abort();
        }
        trackActiveCronTaskRunSettlement(core.promise, controller.signal);

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
        core.resolve();
        await core.promise;
        await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
        vi.useRealTimers();
        resetActiveCronTaskRunsForTests();
      }
    },
  );

  it("does not retire an unrelated active run when one registered run is cancelled", async () => {
    vi.useFakeTimers();
    const cancelledController = new AbortController();
    const unaffectedController = new AbortController();
    const cancelledRun = createDeferred();
    const unaffectedRun = createDeferred();
    let release: (() => void) | undefined;

    try {
      resetActiveCronTaskRunsForTests();
      trackActiveCronTaskRunSettlement(cancelledRun.promise, cancelledController.signal);
      trackActiveCronTaskRunSettlement(unaffectedRun.promise, unaffectedController.signal);
      release = registerActiveCronTaskRun({
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
      release?.();
      cancelledRun.resolve();
      unaffectedRun.resolve();
      await Promise.allSettled([cancelledRun.promise, unaffectedRun.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
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
    const cancellableCore = createDeferred();
    const handlelessCore = createDeferred();
    let release: (() => void) | undefined;
    try {
      resetActiveCronTaskRunsForTests();
      if (cancellableRuns > 0) {
        trackActiveCronTaskRunSettlement(cancellableCore.promise, controller.signal);
      }
      if (handlelessRuns > 0) {
        trackActiveCronTaskRunSettlement(handlelessCore.promise);
      }
      release =
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
      release?.();
      cancellableCore.resolve();
      handlelessCore.resolve();
      await Promise.allSettled([cancellableCore.promise, handlelessCore.promise]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
      resetActiveCronTaskRunsForTests();
    }
  });

  it("keeps suspension blocked until a timed-out core actually settles", async () => {
    resetActiveCronTaskRunsForTests();
    const controller = new AbortController();
    const core = createDeferred();
    trackActiveCronTaskRunSettlement(core.promise, controller.signal);
    controller.abort();

    try {
      expect(getSuspensionVisibleCronTaskRunCount()).toBe(1);
      core.resolve();
      await core.promise;
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    } finally {
      core.resolve();
      await core.promise;
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
    }
  });
});

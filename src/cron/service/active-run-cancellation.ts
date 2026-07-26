// Process-local cancellation handles for live cron task runs.

type CronTaskCancelHandle = {
  controller: AbortController;
  onCancel?: (reason: string) => void;
};

type SettlingCronTaskRun = {
  retirementTimer?: NodeJS.Timeout;
};

const activeCronTaskRunsByRunId = new Map<string, CronTaskCancelHandle>();
const settlingCronTaskRuns = new Map<Promise<unknown>, SettlingCronTaskRun>();
// Restart drain may retire an abort-ignoring core after a bounded grace, but a
// host snapshot must keep refusing readiness until that core actually settles.
const suspensionVisibleCronTaskRuns = new Set<Promise<unknown>>();
const DEFAULT_CRON_TASK_RUN_DRAIN_POLL_MS = 25;
const CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS = 60_000;

export function startActiveCronTaskRunSettlementGrace(): void {
  for (const [promise, entry] of settlingCronTaskRuns) {
    if (entry.retirementTimer) {
      continue;
    }
    const retirementTimer = setTimeout(() => {
      settlingCronTaskRuns.delete(promise);
    }, CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS);
    retirementTimer.unref?.();
    entry.retirementTimer = retirementTimer;
  }
}

export function registerActiveCronTaskRun(params: {
  runId: string | undefined;
  controller: AbortController;
  onCancel?: (reason: string) => void;
}): (() => void) | undefined {
  const runId = params.runId?.trim();
  if (!runId) {
    return undefined;
  }
  activeCronTaskRunsByRunId.set(runId, {
    controller: params.controller,
    onCancel: params.onCancel,
  });
  return () => {
    if (activeCronTaskRunsByRunId.get(runId)?.controller === params.controller) {
      activeCronTaskRunsByRunId.delete(runId);
    }
  };
}

export function abortActiveCronTaskRuns(reason = "Gateway restarting."): number {
  let aborted = 0;
  for (const handle of activeCronTaskRunsByRunId.values()) {
    if (handle.controller.signal.aborted) {
      continue;
    }
    handle.controller.abort(reason);
    handle.onCancel?.(reason);
    aborted += 1;
  }
  if (aborted > 0) {
    startActiveCronTaskRunSettlementGrace();
  }
  return aborted;
}

export function trackActiveCronTaskRunSettlement(promise: Promise<unknown>): void {
  settlingCronTaskRuns.set(promise, {});
  suspensionVisibleCronTaskRuns.add(promise);
  void promise
    .catch(() => undefined)
    .finally(() => {
      const entry = settlingCronTaskRuns.get(promise);
      if (entry?.retirementTimer) {
        clearTimeout(entry.retirementTimer);
      }
      settlingCronTaskRuns.delete(promise);
      suspensionVisibleCronTaskRuns.delete(promise);
    });
}

/** Cron cores that can still mutate state even after timeout/cancel returned. */
export function getSuspensionVisibleCronTaskRunCount(): number {
  return suspensionVisibleCronTaskRuns.size;
}

/** Retires restart-drain bookkeeping without hiding still-running cores from suspension. */
export function retireActiveCronTaskRunTracking(): void {
  activeCronTaskRunsByRunId.clear();
  for (const entry of settlingCronTaskRuns.values()) {
    if (entry.retirementTimer) {
      clearTimeout(entry.retirementTimer);
    }
  }
  settlingCronTaskRuns.clear();
}

export async function waitForActiveCronTaskRuns(timeoutMs: number): Promise<{
  drained: boolean;
  active: number;
}> {
  const deadline = Date.now() + Math.max(0, Math.floor(timeoutMs));
  while (
    (activeCronTaskRunsByRunId.size > 0 || settlingCronTaskRuns.size > 0) &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, DEFAULT_CRON_TASK_RUN_DRAIN_POLL_MS);
    });
  }
  return {
    drained: activeCronTaskRunsByRunId.size === 0 && settlingCronTaskRuns.size === 0,
    active: activeCronTaskRunsByRunId.size + settlingCronTaskRuns.size,
  };
}

export function cancelActiveCronTaskRun(params: {
  runId: string | undefined;
  reason?: string;
}): boolean {
  const runId = params.runId?.trim();
  if (!runId) {
    return false;
  }
  const handle = activeCronTaskRunsByRunId.get(runId);
  if (!handle || handle.controller.signal.aborted) {
    return false;
  }
  const reason = params.reason?.trim() || "Cancelled by operator.";
  handle.controller.abort(reason);
  handle.onCancel?.(reason);
  startActiveCronTaskRunSettlementGrace();
  return true;
}

function resetActiveCronTaskRunsForTests(): void {
  retireActiveCronTaskRunTracking();
  suspensionVisibleCronTaskRuns.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.activeCronTaskRunTestApi")] = {
    resetActiveCronTaskRunsForTests,
  };
}

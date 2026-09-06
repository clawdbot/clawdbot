// Process-local cancellation handles for live cron task runs.

import type { CronActiveJobMarker } from "../active-jobs.js";

const activeCronTaskRunsByRunId = new Map<
  string,
  { controller: AbortController; onCancel?: (reason: string) => void }
>();
const settlingCronTaskRuns = new Map<Promise<unknown>, { retirementTimer?: NodeJS.Timeout }>();
const activeCronTaskRunDrainWaiters = new Set<() => void>();
// Restart drain may retire an abort-ignoring core after a bounded grace, but a
// host snapshot must keep refusing readiness until that core actually settles.
const suspensionVisibleCronTaskRuns = new Map<Promise<unknown>, string | undefined>();
const CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS = 60_000;

function notifyActiveCronTaskRunDrainWaitersIfEmpty(): void {
  if (activeCronTaskRunsByRunId.size > 0 || settlingCronTaskRuns.size > 0) {
    return;
  }
  for (const resolve of activeCronTaskRunDrainWaiters) {
    resolve();
  }
  activeCronTaskRunDrainWaiters.clear();
}

function startActiveCronTaskRunSettlementGrace(promise: Promise<unknown>): void {
  const entry = settlingCronTaskRuns.get(promise);
  if (!entry || entry.retirementTimer) {
    return;
  }
  entry.retirementTimer = setTimeout(() => {
    settlingCronTaskRuns.delete(promise);
    notifyActiveCronTaskRunDrainWaitersIfEmpty();
  }, CRON_TASK_RUN_SETTLEMENT_TRACKING_MAX_MS);
  entry.retirementTimer.unref?.();
}

export function registerActiveCronTaskRun(params: {
  runId: string | undefined;
  controller: AbortController;
  activeJobMarker?: CronActiveJobMarker;
  onCancel?: (reason: string) => void;
}): (() => void) | undefined {
  const runId = params.runId?.trim();
  if (!runId) {
    return undefined;
  }
  const handle = {
    controller: params.controller,
    onCancel: params.onCancel,
  };
  activeCronTaskRunsByRunId.set(runId, handle);
  // A durable remove/disable can land after marker admission but before this
  // controller exists; consume that exact marker's request before provider work.
  const cancelJobRun = (reason: string) => {
    cancelActiveCronTaskRun({ runId, reason });
  };
  if (params.activeJobMarker?.cancellation?.kind === "requested") {
    cancelJobRun(params.activeJobMarker.cancellation.reason);
  } else if (params.activeJobMarker) {
    params.activeJobMarker.cancellation = { kind: "bound", cancel: cancelJobRun };
  }
  return () => {
    if (
      params.activeJobMarker?.cancellation?.kind === "bound" &&
      params.activeJobMarker.cancellation.cancel === cancelJobRun
    ) {
      delete params.activeJobMarker.cancellation;
    }
    if (activeCronTaskRunsByRunId.get(runId)?.controller === params.controller) {
      activeCronTaskRunsByRunId.delete(runId);
      notifyActiveCronTaskRunDrainWaitersIfEmpty();
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
  // Shutdown also retires main-session runs without cancellation handles.
  for (const promise of settlingCronTaskRuns.keys()) {
    startActiveCronTaskRunSettlementGrace(promise);
  }
  return aborted;
}

export function trackActiveCronTaskRunSettlement(
  promise: Promise<unknown>,
  abortSignal?: AbortSignal,
  agentId?: string,
): void {
  settlingCronTaskRuns.set(promise, {});
  suspensionVisibleCronTaskRuns.set(promise, agentId);
  // Cancellation belongs to this core only; sibling jobs must remain drain-visible.
  const startSettlementGrace = () => startActiveCronTaskRunSettlementGrace(promise);
  abortSignal?.addEventListener("abort", startSettlementGrace, { once: true });
  if (abortSignal?.aborted) {
    startSettlementGrace();
  }
  void promise
    .catch(() => undefined)
    .finally(() => {
      abortSignal?.removeEventListener("abort", startSettlementGrace);
      const entry = settlingCronTaskRuns.get(promise);
      if (entry?.retirementTimer) {
        clearTimeout(entry.retirementTimer);
      }
      settlingCronTaskRuns.delete(promise);
      suspensionVisibleCronTaskRuns.delete(promise);
      notifyActiveCronTaskRunDrainWaitersIfEmpty();
    });
}

/** Cron cores that can still mutate state even after timeout/cancel returned. */
export function getSuspensionVisibleCronTaskRunCount(scope?: { agentId: string }): number {
  if (!scope) {
    return suspensionVisibleCronTaskRuns.size;
  }
  let count = 0;
  for (const agentId of suspensionVisibleCronTaskRuns.values()) {
    // An unclassified core cannot establish that an agent's filesystem is safe.
    if (!agentId || agentId === scope.agentId) {
      count += 1;
    }
  }
  return count;
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
  notifyActiveCronTaskRunDrainWaitersIfEmpty();
}

export async function waitForActiveCronTaskRuns(timeoutMs: number): Promise<{
  drained: boolean;
  active: number;
}> {
  const waitMs = Math.max(0, Math.floor(timeoutMs));
  if (waitMs > 0 && (activeCronTaskRunsByRunId.size > 0 || settlingCronTaskRuns.size > 0)) {
    await new Promise<void>((resolve) => {
      const waiter = () => {
        clearTimeout(timeout);
        resolve();
      };
      // A native timer bounds shutdown independently of wall-clock jumps.
      const timeout = setTimeout(() => {
        activeCronTaskRunDrainWaiters.delete(waiter);
        resolve();
      }, waitMs);
      activeCronTaskRunDrainWaiters.add(waiter);
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

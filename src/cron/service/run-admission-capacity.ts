import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import type { CronServiceState } from "./state.js";

export function resolveRunConcurrency(): number {
  return DEFAULT_CRON_MAX_CONCURRENT_RUNS;
}

function acquireCronRunSlot(state: CronServiceState): () => void {
  state.runAdmission.active += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    state.runAdmission.active -= 1;
    dispatchWaiters(state);
  };
}

function dispatchWaiters(state: CronServiceState): void {
  const admission = state.runAdmission;
  if (state.stopped) {
    cancelCronRunAdmissionWaiters(state);
    return;
  }
  const maxConcurrentRuns = resolveRunConcurrency();
  while (admission.active < maxConcurrentRuns) {
    const waiter = admission.waiters.shift();
    if (!waiter) {
      break;
    }
    waiter(acquireCronRunSlot(state));
  }
  if (admission.active < maxConcurrentRuns && admission.waiters.length === 0) {
    const listener = admission.capacityListener;
    admission.capacityListener = null;
    if (listener) {
      queueMicrotask(listener);
    }
  }
}

/**
 * Acquire only the slots currently available to scheduled work. Unlike the
 * waiter-based path used by direct runs, this never retains a timer batch while
 * the pool is saturated.
 */
export function tryAcquireCronRunSlots(
  state: CronServiceState,
  requested: number,
): Array<() => void> {
  if (state.stopped || requested <= 0 || state.runAdmission.waiters.length > 0) {
    return [];
  }
  const available = Math.max(0, resolveRunConcurrency() - state.runAdmission.active);
  return Array.from({ length: Math.min(requested, available) }, () => acquireCronRunSlot(state));
}

/** Keep the first wake-up until capacity release consumes or cancellation clears it. */
export function setCronRunCapacityListener(state: CronServiceState, listener: () => void): void {
  state.runAdmission.capacityListener ??= listener;
}

async function acquireCronRunAdmission(state: CronServiceState): Promise<(() => void) | null> {
  const admission = state.runAdmission;
  if (state.stopped) {
    return null;
  }
  if (admission.waiters.length === 0 && admission.active < resolveRunConcurrency()) {
    return acquireCronRunSlot(state);
  }
  return await new Promise<(() => void) | null>((resolve) => {
    admission.waiters.push(resolve);
  });
}

/** Wake queued work on stop so each caller can release its durable reservation. */
export function cancelCronRunAdmissionWaiters(state: CronServiceState): void {
  state.runAdmission.capacityListener = null;
  const waiters = state.runAdmission.waiters.splice(0);
  for (const waiter of waiters) {
    waiter(null);
  }
}

/** Apply one service-level cap to every cron execution source. Queue waiters
 * keep their job reservation, then recheck scheduler state before execution.
 */
export async function runWithCronAdmission<T>(
  state: CronServiceState,
  execute: () => Promise<T>,
  acquiredRelease?: () => void,
): Promise<{ kind: "admitted"; value: T } | { kind: "stopped" }> {
  const release = acquiredRelease ?? (await acquireCronRunAdmission(state));
  if (!release) {
    return { kind: "stopped" };
  }
  try {
    return { kind: "admitted", value: await execute() };
  } finally {
    release();
  }
}

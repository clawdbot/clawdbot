import type { CronRunReceiptRecoveryCandidate } from "../store/run-receipt-store.js";
import type { CronServiceState } from "./state.js";

// Lifecycle-owned freshness exception: only the bounded active foreign-receipt
// set is rechecked, every two seconds, until exact receipt identity retires.
const CRON_FOREIGN_RECEIPT_RECHECK_MS = 2_000;
type Monitor = {
  byJobId: Map<string, CronRunReceiptRecoveryCandidate>;
  reconcile?: () => Promise<void>;
  timer: NodeJS.Timeout | null;
};
const monitors = new WeakMap<CronServiceState, Monitor>();

function monitor(state: CronServiceState): Monitor {
  let current = monitors.get(state);
  if (!current) {
    current = { byJobId: new Map(), timer: null };
    monitors.set(state, current);
  }
  return current;
}

function arm(state: CronServiceState): void {
  const current = monitor(state);
  const reconcile = current.reconcile;
  if (state.stopped || current.timer || current.byJobId.size === 0 || !reconcile) {
    return;
  }
  current.timer = setTimeout(() => {
    current.timer = null;
    void reconcile()
      .catch((error: unknown) => {
        state.deps.log.warn({ err: String(error) }, "cron: foreign receipt reconciliation failed");
      })
      .finally(() => arm(state));
  }, CRON_FOREIGN_RECEIPT_RECHECK_MS);
  current.timer.unref?.();
}

export function configureForeignReceiptMonitor(
  state: CronServiceState,
  reconcile: () => Promise<void>,
): void {
  monitor(state).reconcile = reconcile;
  arm(state);
}

export function enrollForeignReceipt(
  state: CronServiceState,
  receipt: CronRunReceiptRecoveryCandidate,
): void {
  monitor(state).byJobId.set(receipt.jobId, receipt);
  arm(state);
}

export function listForeignReceipts(state: CronServiceState): CronRunReceiptRecoveryCandidate[] {
  return [...monitor(state).byJobId.values()].toSorted((left, right) =>
    left.jobId.localeCompare(right.jobId),
  );
}

export function removeForeignReceipt(state: CronServiceState, jobId: string): void {
  monitor(state).byJobId.delete(jobId);
}

export function stopForeignReceiptMonitor(state: CronServiceState): void {
  const current = monitor(state);
  if (current.timer) {
    clearTimeout(current.timer);
    current.timer = null;
  }
  current.byJobId.clear();
  current.reconcile = undefined;
}

export function resumeForeignReceiptMonitor(state: CronServiceState): void {
  arm(state);
}

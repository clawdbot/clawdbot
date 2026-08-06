import { resolveTimerTimeoutMs } from "../../shared/number-coercion.js";

const REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS = 60_000;
export type ReplyOperationStaleReason =
  | "terminal_unreleased"
  | "finalization_stalled"
  | "no_activity"
  | "stuck_recovery";

export function formatReplyOperationResult(
  result: { kind: "completed" } | { kind: string; code: string } | null,
): string {
  if (!result) {
    return "none";
  }
  return "code" in result ? `${result.kind}:${result.code}` : result.kind;
}

type FinalizationLease = {
  begin(): void;
  beginWork(timeoutMs: number): () => void;
  clear(): void;
  recordActivity(): void;
};

type ReplyRunSettleTimer = {
  clear(): void;
  renew(timeoutMs: number): void;
  scheduleOnce(timeoutMs: number): void;
};

const activeLeases = new Set<FinalizationLease>();
const activeSettleTimers = new Set<ReplyRunSettleTimer>();
const leasesByOwner = new WeakMap<object, FinalizationLease>();

export function createReplyRunSettleTimer(params: {
  canExpire: () => boolean;
  onExpire: () => void;
}): ReplyRunSettleTimer {
  let timer: NodeJS.Timeout | undefined;
  const settleTimer: ReplyRunSettleTimer = {
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      activeSettleTimers.delete(settleTimer);
    },
    renew(timeoutMs) {
      settleTimer.clear();
      timer = setTimeout(
        () => {
          timer = undefined;
          activeSettleTimers.delete(settleTimer);
          if (params.canExpire()) {
            params.onExpire();
          }
        },
        resolveTimerTimeoutMs(timeoutMs, REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS, 1),
      );
      timer.unref?.();
      activeSettleTimers.add(settleTimer);
    },
    scheduleOnce(timeoutMs) {
      if (!timer) {
        settleTimer.renew(timeoutMs);
      }
    },
  };
  return settleTimer;
}

export function createReplyRunFinalizationLease(params: {
  owner: object;
  canExpire: () => boolean;
  onActivity: () => void;
  onExpire: () => void;
  onFinalizationProgress: () => void;
}): FinalizationLease {
  let finalizing = false;
  let defaultDeadlineMs = 0;
  const workDeadlinesMs = new Map<symbol, number>();
  const settleTimer = createReplyRunSettleTimer({
    canExpire: () => finalizing && params.canExpire(),
    onExpire: params.onExpire,
  });
  const schedule = () => {
    const workDeadlineMs = Math.max(0, ...workDeadlinesMs.values());
    const deadlineMs = Math.max(defaultDeadlineMs, workDeadlineMs);
    settleTimer.renew(Math.max(1, deadlineMs - Date.now()));
  };
  const recordActivity = () => {
    params.onActivity();
    if (finalizing) {
      defaultDeadlineMs = Date.now() + REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS;
      params.onFinalizationProgress();
      schedule();
    }
  };
  const lease: FinalizationLease = {
    begin() {
      if (!params.canExpire()) {
        return;
      }
      finalizing = true;
      activeLeases.add(lease);
      recordActivity();
    },
    beginWork(timeoutMs) {
      const workId = Symbol("reply-finalization-work");
      workDeadlinesMs.set(
        workId,
        Date.now() + resolveTimerTimeoutMs(timeoutMs, REPLY_RUN_FINALIZATION_SETTLE_TIMEOUT_MS, 1),
      );
      recordActivity();
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        workDeadlinesMs.delete(workId);
        if (finalizing) {
          schedule();
        }
      };
    },
    clear() {
      finalizing = false;
      defaultDeadlineMs = 0;
      workDeadlinesMs.clear();
      settleTimer.clear();
      activeLeases.delete(lease);
      leasesByOwner.delete(params.owner);
    },
    recordActivity,
  };
  leasesByOwner.set(params.owner, lease);
  return lease;
}

export function beginReplyOperationFinalizationWork(owner: object, timeoutMs: number): () => void {
  return leasesByOwner.get(owner)?.beginWork(timeoutMs) ?? (() => undefined);
}

export function resetReplyRunSettleTimersForTesting(): void {
  for (const lease of activeLeases) {
    lease.clear();
  }
  activeLeases.clear();
  for (const timer of activeSettleTimers) {
    timer.clear();
  }
  activeSettleTimers.clear();
}

import type { HeartbeatRunResult } from "./heartbeat-wake-contracts.js";

export type HeartbeatWakeSettlement = {
  active: boolean;
  settle: (result: HeartbeatRunResult) => void;
};

export function activeHeartbeatWakeSettlements(
  ...groups: Array<readonly HeartbeatWakeSettlement[] | undefined>
): HeartbeatWakeSettlement[] {
  return groups.flatMap((group) => group ?? []).filter((settlement) => settlement.active);
}

export function settleHeartbeatWakeSettlements(
  settlements: readonly HeartbeatWakeSettlement[] | undefined,
  result: HeartbeatRunResult,
) {
  for (const settlement of settlements ?? []) {
    settlement.settle(result);
  }
}

function createHeartbeatWakeSettlement(abortSignal?: AbortSignal): {
  result: Promise<HeartbeatRunResult>;
  settlement: HeartbeatWakeSettlement;
} {
  const control: {
    resolve?: (result: HeartbeatRunResult) => void;
    removeAbortListener?: () => void;
  } = {};
  const result = new Promise<HeartbeatRunResult>((resolve) => {
    control.resolve = resolve;
  });
  const settlement: HeartbeatWakeSettlement = {
    active: true,
    settle: (outcome) => {
      if (!settlement.active) {
        return;
      }
      settlement.active = false;
      control.removeAbortListener?.();
      control.resolve?.(outcome);
    },
  };
  const onAbort = () => settlement.settle({ status: "failed", reason: "heartbeat wake cancelled" });
  control.removeAbortListener = () => abortSignal?.removeEventListener("abort", onAbort);
  if (abortSignal?.aborted) {
    onAbort();
  } else {
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  }
  return { result, settlement };
}

export function createRequestHeartbeatAndWait<Request>(
  enqueue: (request: Request, settlements?: HeartbeatWakeSettlement[]) => void,
) {
  return (request: Request, lifecycle?: { abortSignal?: AbortSignal }) => {
    const pending = createHeartbeatWakeSettlement(lifecycle?.abortSignal);
    if (pending.settlement.active) {
      enqueue(request, [pending.settlement]);
    }
    return pending.result;
  };
}

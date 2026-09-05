import { AsyncLocalStorage } from "node:async_hooks";
import type {
  HeartbeatRunResult,
  HeartbeatWakeHandler,
  HeartbeatWakeRequest,
} from "./heartbeat-wake-contracts.js";

export type ActiveHeartbeatWakeTarget = {
  generation: number;
  abortController: AbortController;
};

const heartbeatWakeAbortSignals = new AsyncLocalStorage<AbortSignal>();

/** Propagate lifecycle cancellation into the provider's existing reply abort contract. */
export function getHeartbeatWakeAbortSignal(): AbortSignal | undefined {
  return heartbeatWakeAbortSignals.getStore();
}

export async function runAbortableHeartbeatWake(
  active: HeartbeatWakeHandler,
  wake: HeartbeatWakeRequest,
  signal: AbortSignal,
): Promise<HeartbeatRunResult> {
  signal.throwIfAborted();
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      const abortReason = signal.reason;
      reject(
        abortReason instanceof Error ? abortReason : new Error("Heartbeat handler was replaced"),
      );
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    // Keep provider cancellation in the existing reply AbortSignal contract;
    // racing it also retires a non-cooperative stale handler on replacement.
    const running = heartbeatWakeAbortSignals.run(signal, () => active(wake));
    return await Promise.race([running, aborted]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

export function abortHeartbeatWakeGeneration(
  activeTargets: Iterable<ActiveHeartbeatWakeTarget>,
  generation: number,
): void {
  for (const activeTarget of activeTargets) {
    if (activeTarget.generation === generation) {
      activeTarget.abortController.abort();
    }
  }
}

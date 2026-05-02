type RunStateStatusPatch = {
  busy?: boolean;
  activeRuns?: number;
  lastRunActivityAt?: number | null;
};

export type RunStateStatusSink = (patch: RunStateStatusPatch) => void;

type RunStateMachineParams = {
  setStatus?: RunStateStatusSink;
  abortSignal?: AbortSignal;
  heartbeatMs?: number;
  now?: () => number;
};

const DEFAULT_RUN_ACTIVITY_HEARTBEAT_MS = 60_000;

export function createRunStateMachine(params: RunStateMachineParams) {
  const heartbeatMs = params.heartbeatMs ?? DEFAULT_RUN_ACTIVITY_HEARTBEAT_MS;
  const now = params.now ?? Date.now;
  let activeRuns = 0;
  let runActivityHeartbeat: ReturnType<typeof setInterval> | null = null;
  let lifecycleActive = !params.abortSignal?.aborted;

  const publish = () => {
    if (!lifecycleActive) {
      return;
    }
    params.setStatus?.({
      activeRuns,
      busy: activeRuns > 0,
      lastRunActivityAt: now(),
    });
  };

  const clearHeartbeat = () => {
    if (!runActivityHeartbeat) {
      return;
    }
    clearInterval(runActivityHeartbeat);
    runActivityHeartbeat = null;
  };

  const ensureHeartbeat = () => {
    if (runActivityHeartbeat || activeRuns <= 0 || !lifecycleActive) {
      return;
    }
    runActivityHeartbeat = setInterval(() => {
      if (!lifecycleActive || activeRuns <= 0) {
        clearHeartbeat();
        return;
      }
      publish();
    }, heartbeatMs);
    runActivityHeartbeat.unref?.();
  };

  const deactivate = () => {
    lifecycleActive = false;
    clearHeartbeat();
  };

  const onAbort = () => {
    deactivate();
  };

  if (params.abortSignal?.aborted) {
    onAbort();
  } else {
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }

  if (lifecycleActive) {
    // Reset inherited status from previous process lifecycle.
    params.setStatus?.({
      activeRuns: 0,
      busy: false,
    });
  }

  return {
    isActive() {
      return lifecycleActive;
    },
    onRunStart() {
      activeRuns += 1;
      publish();
      ensureHeartbeat();
    },
    onRunEnd() {
      activeRuns = Math.max(0, activeRuns - 1);
      if (activeRuns <= 0) {
        clearHeartbeat();
      }
      publish();
    },
    deactivate,
  };
}

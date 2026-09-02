// Pre-stream setup watchdog for heartbeat runs.
//
// Heartbeat uses the main-session reply path, so it does not get the isolated
// agent setup/pre-execution watchdog in src/cron/service/agent-watchdog.ts. This
// module provides a bounded guard that fails fast when lane admission, workspace
// bootstrap, prompt build, or model resolution stalls before a provider stream
// is created.

// Bound the pre-stream heartbeat preparation phase (lane admission, workspace
// bootstrap, prompt build, model resolution) so a stall fails fast with a stage
// name instead of silently waiting for the outer cron watchdog.
const HEARTBEAT_SETUP_WATCHDOG_MS = 60_000;

export function resolveHeartbeatSetupTimeoutMs(
  heartbeatTimeoutSeconds: number | undefined,
  overrideMs?: number,
): number {
  if (overrideMs !== undefined) {
    return overrideMs;
  }
  if (heartbeatTimeoutSeconds === undefined || heartbeatTimeoutSeconds <= 0) {
    return HEARTBEAT_SETUP_WATCHDOG_MS;
  }
  return Math.max(1, Math.min(HEARTBEAT_SETUP_WATCHDOG_MS, heartbeatTimeoutSeconds * 1000));
}

export type HeartbeatSetupAbortController = {
  signal: AbortSignal;
  disarm: () => void;
};

export function createHeartbeatSetupAbortController(params: {
  timeoutMs: number;
  heartbeatWakeAbortSignal?: AbortSignal;
  onTimeout: () => Error;
}): HeartbeatSetupAbortController {
  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;

  const disarm = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };

  const { heartbeatWakeAbortSignal } = params;
  if (heartbeatWakeAbortSignal?.aborted) {
    controller.abort(heartbeatWakeAbortSignal.reason);
  } else {
    heartbeatWakeAbortSignal?.addEventListener(
      "abort",
      () => controller.abort(heartbeatWakeAbortSignal.reason),
      { once: true },
    );
  }

  if (!controller.signal.aborted) {
    timeoutId = setTimeout(() => {
      controller.abort(params.onTimeout());
    }, params.timeoutMs);
  }

  return { signal: controller.signal, disarm };
}

// Armable idle watchdog for long-running channel transports.
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import type { RuntimeEnv } from "../../runtime.js";

export type StallWatchdogTimeoutMeta = {
  idleMs: number;
  timeoutMs: number;
};

/** Public control surface for a transport stall watchdog instance. */
export type ArmableStallWatchdog = {
  arm: (atMs?: number) => void;
  touch: (atMs?: number) => void;
  disarm: () => void;
  stop: () => void;
  isArmed: () => boolean;
};

function stringifyFailure(error: unknown): string {
  try {
    return String(error);
  } catch {
    // Thrown values are hostile input; coercion must not create a second failure
    // that escapes the watchdog's timer boundary.
    return "Unknown error";
  }
}

/** Creates a watchdog that reports once when an armed transport goes idle. */
export function createArmableStallWatchdog(params: {
  label: string;
  timeoutMs: number;
  checkIntervalMs?: number;
  abortSignal?: AbortSignal;
  runtime?: RuntimeEnv;
  onTimeout: (meta: StallWatchdogTimeoutMeta) => void;
}): ArmableStallWatchdog {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  const defaultCheckIntervalMs = Math.min(5_000, Math.max(250, timeoutMs / 6));
  const checkIntervalMs = resolveTimerTimeoutMs(
    params.checkIntervalMs,
    defaultCheckIntervalMs,
    100,
  );

  let armed = false;
  let stopped = false;
  let lastActivityAt = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;

  const report = (message: string) => {
    try {
      const result = params.runtime?.error?.(message);
      // Keep the public reporter contract void while assimilating host callbacks
      // that return a thenable, so their rejection cannot escape this timer boundary.
      void Promise.resolve(result).catch(() => {});
    } catch {
      // Runtime reporters are host-owned too; a reporter failure must not escape
      // this timer boundary and terminate the gateway process.
    }
  };
  const reportTimeoutFailure = (error: unknown) =>
    report(
      `[${params.label}] transport watchdog timeout handler failed: ${stringifyFailure(error)}`,
    );

  const clearTimer = () => {
    if (!timer) {
      return;
    }
    clearInterval(timer);
    timer = null;
  };

  const disarm = () => {
    armed = false;
  };

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    disarm();
    clearTimer();
    params.abortSignal?.removeEventListener("abort", stop);
  };

  const arm = (atMs?: number) => {
    if (stopped) {
      return;
    }
    lastActivityAt = atMs ?? Date.now();
    armed = true;
  };

  const touch = (atMs?: number) => {
    if (stopped) {
      return;
    }
    lastActivityAt = atMs ?? Date.now();
  };

  const check = () => {
    if (!armed || stopped) {
      return;
    }
    const now = Date.now();
    const idleMs = now - lastActivityAt;
    if (idleMs < timeoutMs) {
      return;
    }
    // Disarm before invoking onTimeout so retries or teardown cannot fire a
    // second timeout from the same idle interval.
    disarm();
    report(
      `[${params.label}] transport watchdog timeout: idle ${Math.round(idleMs / 1000)}s (limit ${Math.round(timeoutMs / 1000)}s)`,
    );
    try {
      void Promise.resolve(params.onTimeout({ idleMs, timeoutMs })).catch(reportTimeoutFailure);
    } catch (error) {
      reportTimeoutFailure(error);
    }
  };

  if (params.abortSignal?.aborted) {
    stop();
  } else {
    params.abortSignal?.addEventListener("abort", stop, { once: true });
    timer = setInterval(check, checkIntervalMs);
    timer.unref?.();
  }

  return {
    arm,
    touch,
    disarm,
    stop,
    isArmed: () => armed,
  };
}

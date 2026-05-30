import type { RuntimeEnv } from "../../runtime.js";
import { resolveTimerTimeoutMs } from "../../shared/number-coercion.js";

export type StallWatchdogTimeoutMeta = {
  idleMs: number;
  timeoutMs: number;
};

export type ArmableStallWatchdog = {
  arm: (atMs?: number) => void;
  touch: (atMs?: number) => void;
  disarm: () => void;
  stop: () => void;
  isArmed: () => boolean;
};

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
    disarm();
    params.runtime?.error?.(
      `[${params.label}] transport watchdog timeout: idle ${Math.round(idleMs / 1000)}s (limit ${Math.round(timeoutMs / 1000)}s)`,
    );
    params.onTimeout({ idleMs, timeoutMs });
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

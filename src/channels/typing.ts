// Typing indicator lifecycle controller for reply dispatchers.
import {
  parseFiniteNumber,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { createTypingKeepaliveLoop } from "./typing-lifecycle.js";
import { createTypingStartGuard } from "./typing-start-guard.js";

export type TypingCallbacks = {
  onReplyStart: () => Promise<void>;
  onIdle?: () => void;
  /** Called when the typing controller is cleaned up (e.g. on NO_REPLY). */
  onCleanup?: () => void;
};

export type CreateTypingCallbacksParams = {
  start: () => Promise<void>;
  stop?: () => Promise<void>;
  onStartError: (err: unknown) => void;
  onStopError?: (err: unknown) => void;
  keepaliveIntervalMs?: number;
  /** Stop keepalive after this many consecutive start() failures. Default: 2 */
  maxConsecutiveFailures?: number;
  /** Maximum duration for typing indicator before auto-cleanup (safety TTL). Default: 60s */
  maxDurationMs?: number;
};

function resolvePositiveIntegerOption(value: number | undefined, fallback: number): number {
  const parsed = parseFiniteNumber(value);
  return parsed === undefined || parsed <= 0 ? fallback : Math.max(1, Math.floor(parsed));
}

function resolveKeepaliveIntervalMs(value: number | undefined): number {
  return resolveTimerTimeoutMs(value, 3_000, 0);
}

function resolveDurationMsOption(value: number | undefined, fallback: number): number {
  return resolveTimerTimeoutMs(value, fallback, 0);
}

export function createTypingCallbacks(params: CreateTypingCallbacksParams): TypingCallbacks {
  const stop = params.stop;
  const keepaliveIntervalMs = resolveKeepaliveIntervalMs(params.keepaliveIntervalMs);
  const maxConsecutiveFailures = resolvePositiveIntegerOption(params.maxConsecutiveFailures, 2);
  const maxDurationMs = resolveDurationMsOption(params.maxDurationMs, 60_000);
  let stopSent = false;
  let closed = false;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;

  const startGuard = createTypingStartGuard({
    isSealed: () => closed,
    onStartError: params.onStartError,
    maxConsecutiveFailures,
    onTrip: () => {
      keepaliveLoop.stop();
    },
  });

  const fireStart = async (): Promise<void> => {
    await startGuard.run(() => params.start());
  };

  const keepaliveLoop = createTypingKeepaliveLoop({
    intervalMs: keepaliveIntervalMs,
    onTick: fireStart,
  });

  const startTtlTimer = () => {
    if (maxDurationMs <= 0) {
      return;
    }
    clearTtlTimer();
    ttlTimer = setTimeout(() => {
      if (!closed) {
        console.warn(`[typing] TTL exceeded (${maxDurationMs}ms), auto-stopping typing indicator`);
        fireStop();
      }
    }, maxDurationMs);
    ttlTimer.unref?.();
  };

  const clearTtlTimer = () => {
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = undefined;
    }
  };

  const onReplyStart = async () => {
    if (closed) {
      return;
    }
    stopSent = false;
    startGuard.reset();
    keepaliveLoop.stop();
    clearTtlTimer();
    const startPromise = fireStart();
    void startPromise.then(() => {
      if (closed || startGuard.isTripped()) {
        return;
      }
      keepaliveLoop.start();
      startTtlTimer();
    });
    await Promise.resolve();
  };

  const fireStop = () => {
    closed = true;
    keepaliveLoop.stop();
    clearTtlTimer();
    if (!stop || stopSent) {
      return;
    }
    stopSent = true;
    void stop().catch((err: unknown) => (params.onStopError ?? params.onStartError)(err));
  };

  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}

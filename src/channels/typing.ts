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
  /** Wait this long before starting the indicator. Cleanup during the delay cancels it. */
  initialDelayMs?: number;
  keepaliveIntervalMs?: number;
  /** Stop keepalive after this many consecutive start() failures. Default: 2 */
  maxConsecutiveFailures?: number;
  /** Maximum duration for typing indicator before auto-cleanup (safety TTL). Default: 60s */
  maxDurationMs?: number;
};

const DEFAULT_MAX_CONSECUTIVE_TYPING_FAILURES = 2;

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
  const maxConsecutiveFailures = resolvePositiveIntegerOption(
    params.maxConsecutiveFailures,
    DEFAULT_MAX_CONSECUTIVE_TYPING_FAILURES,
  );
  const maxDurationMs = resolveDurationMsOption(params.maxDurationMs, 60_000);
  const initialDelayMs = resolveDurationMsOption(params.initialDelayMs, 0);
  let stopSent = false;
  let closed = false;
  let startSent = false;
  let startDelayTimer: ReturnType<typeof setTimeout> | undefined;
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

  const clearStartDelayTimer = () => {
    if (startDelayTimer) {
      clearTimeout(startDelayTimer);
      startDelayTimer = undefined;
    }
  };

  const startTyping = () => {
    if (closed) {
      return;
    }
    startSent = true;
    const startPromise = fireStart();
    void startPromise.then(() => {
      if (closed || startGuard.isTripped()) {
        return;
      }
      // Core can refresh an active reply independently of this channel loop.
      // Restarting the interval here shifts its deadline and can outlive a
      // provider's visible typing window between consecutive renewals.
      keepaliveLoop.start();
      startTtlTimer();
    });
  };

  const onReplyStart = async () => {
    if (closed) {
      return;
    }
    stopSent = false;
    startGuard.reset();
    clearTtlTimer();
    if (!startSent && initialDelayMs > 0) {
      if (!startDelayTimer) {
        startDelayTimer = setTimeout(() => {
          startDelayTimer = undefined;
          startTyping();
        }, initialDelayMs);
        startDelayTimer.unref?.();
      }
      await Promise.resolve();
      return;
    }
    startTyping();
    await Promise.resolve();
  };

  const fireStop = () => {
    closed = true;
    keepaliveLoop.stop();
    clearStartDelayTimer();
    clearTtlTimer();
    if (!stop || stopSent) {
      return;
    }
    stopSent = true;
    void stop().catch((err: unknown) => (params.onStopError ?? params.onStartError)(err));
  };

  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}

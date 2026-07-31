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
  /**
   * Hard lifetime cap: absolute wall-clock ceiling armed ONCE at `onReplyStart`
   * and never refreshed by successful keepalives. This preserves the historical
   * exported meaning of `maxDurationMs` — a caller that sets `maxDurationMs: 10_000`
   * still gets at most a 10s indicator lifetime regardless of keepalive success.
   * Guarantees teardown even if a caller's normal cleanup is missed while `start()`
   * keeps succeeding. Default: 600s (10 min). Pass `0` to disable.
   */
  maxDurationMs?: number;
  /**
   * Idle-safety TTL: max quiet time without a successful `start()` / keepalive tick
   * before auto-cleanup. Each successful start refreshes (slides) this window so long
   * agent turns keep the channel indicator while keepalive is healthy, fixing the
   * premature teardown during multi-minute tool/steer turns. Default: 60s.
   * Pass `0` to disable.
   */
  idleTimeoutMs?: number;
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
  // Hard lifetime cap (armed once, never slid) keeps `maxDurationMs`'s historical
  // meaning; the sliding idle window moves to the new `idleTimeoutMs` option.
  const absoluteMaxDurationMs = resolveDurationMsOption(params.maxDurationMs, 600_000);
  const idleTimeoutMs = resolveDurationMsOption(params.idleTimeoutMs, 60_000);
  let stopSent = false;
  let closed = false;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;
  let absoluteTimer: ReturnType<typeof setTimeout> | undefined;

  const startGuard = createTypingStartGuard({
    isSealed: () => closed,
    onStartError: params.onStartError,
    maxConsecutiveFailures,
    onTrip: () => {
      keepaliveLoop.stop();
    },
  });

  const clearTtlTimer = () => {
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = undefined;
    }
  };

  const clearAbsoluteTimer = () => {
    if (absoluteTimer) {
      clearTimeout(absoluteTimer);
      absoluteTimer = undefined;
    }
  };

  // Absolute ceiling: armed once per turn, never refreshed by keepalive success.
  const startAbsoluteTimer = () => {
    if (absoluteMaxDurationMs <= 0 || closed || absoluteTimer) {
      return;
    }
    absoluteTimer = setTimeout(() => {
      if (!closed) {
        console.warn(
          `[typing] absolute TTL exceeded (${absoluteMaxDurationMs}ms since reply start), auto-stopping typing indicator`,
        );
        fireStop();
      }
    }, absoluteMaxDurationMs);
    absoluteTimer.unref?.();
  };

  const startTtlTimer = () => {
    if (idleTimeoutMs <= 0 || closed) {
      return;
    }
    clearTtlTimer();
    ttlTimer = setTimeout(() => {
      if (!closed) {
        console.warn(
          `[typing] idle TTL exceeded (${idleTimeoutMs}ms without successful typing start), auto-stopping typing indicator`,
        );
        fireStop();
      }
    }, idleTimeoutMs);
    ttlTimer.unref?.();
  };

  const fireStart = async (): Promise<void> => {
    await startGuard.run(async () => {
      await params.start();
      // Successful channel action proves liveness: slide the idle safety TTL so
      // multi-minute agent turns (tools, steers) do not hard-kill typing at 60s.
      if (!closed && !startGuard.isTripped()) {
        startTtlTimer();
      }
    });
  };

  const keepaliveLoop = createTypingKeepaliveLoop({
    intervalMs: keepaliveIntervalMs,
    onTick: fireStart,
  });

  const onReplyStart = async () => {
    if (closed) {
      return;
    }
    stopSent = false;
    startGuard.reset();
    clearTtlTimer();
    startAbsoluteTimer();
    const startPromise = fireStart();
    void startPromise.then(() => {
      if (closed || startGuard.isTripped()) {
        return;
      }
      // Core can refresh an active reply independently of this channel loop.
      // Restarting the interval here shifts its deadline and can outlive a
      // provider's visible typing window between consecutive renewals.
      keepaliveLoop.start();
      // fireStart already arms TTL on success; arm again in case start resolved
      // with a tripped-but-then-reset edge, keeping onReplyStart self-contained.
      startTtlTimer();
    });
    await Promise.resolve();
  };

  const fireStop = () => {
    closed = true;
    keepaliveLoop.stop();
    clearTtlTimer();
    clearAbsoluteTimer();
    if (!stop || stopSent) {
      return;
    }
    stopSent = true;
    void stop().catch((err: unknown) => (params.onStopError ?? params.onStartError)(err));
  };

  return { onReplyStart, onIdle: fireStop, onCleanup: fireStop };
}

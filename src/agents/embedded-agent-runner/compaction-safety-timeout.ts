/**
 * Wraps compaction calls with a safety timeout and abort cleanup.
 */
import {
  finiteSecondsToTimerSafeMilliseconds,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompactResult, ContextEngine } from "../../context-engine/types.js";
import { createAbortError } from "../../infra/abort-signal.js";

const EMBEDDED_COMPACTION_TIMEOUT_MS = 180_000;

/** Absolute compaction ceiling as a multiple of the stall budget; see use below. */
const ABSOLUTE_COMPACTION_BUDGET_MULTIPLIER = 10;

function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = "reason" in signal ? signal.reason : undefined;
  if (reason instanceof Error) {
    return reason;
  }
  return createAbortError("aborted", reason ? { cause: reason } : undefined);
}

export function resolveCompactionTimeoutMs(cfg?: OpenClawConfig): number {
  return (
    finiteSecondsToTimerSafeMilliseconds(cfg?.agents?.defaults?.compaction?.timeoutSeconds, {
      floorSeconds: true,
    }) ?? EMBEDDED_COMPACTION_TIMEOUT_MS
  );
}

/**
 * Bounds a compaction call and races it against caller cancellation.
 *
 * The `compact` callback receives an optional second argument — a progress
 * callback. Without progress reports, `timeoutMs` is an aggregate budget (the
 * historical behavior, unchanged for every existing caller). Each progress call
 * re-arms the timer, so a reporting compaction is instead bounded by maximum
 * SILENCE: a slow-but-advancing summarization may run past `timeoutMs` total,
 * while a genuinely hung one still aborts after `timeoutMs` without progress.
 * An independent absolute ceiling (10x `timeoutMs`) that progress can never
 * re-arm bounds a faulty engine that reports progress forever.
 */
export async function compactWithSafetyTimeout<T>(
  compact: (abortSignal?: AbortSignal, onProgress?: () => void) => Promise<T>,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
  opts?: {
    abortSignal?: AbortSignal;
    onCancel?: () => void;
  },
): Promise<T> {
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
  if (!resolvedTimeoutMs) {
    return await compact(undefined, undefined);
  }

  let canceled = false;
  const cancel = () => {
    if (canceled) {
      return;
    }
    canceled = true;
    try {
      opts?.onCancel?.();
    } catch {
      // Best-effort cancellation hook. Keep the timeout/abort path intact even
      // if the underlying compaction cancel operation throws.
    }
  };

  const timeoutAbortCtrl = new AbortController();
  const timeoutError = new Error("Compaction timed out");
  // Timeout precedence: the rejection listener must be the FIRST observer of
  // the timeout signal. A cooperative callback that settles synchronously when
  // aborted (via the composed signal or the cancel hook) would otherwise queue
  // its fulfillment ahead of this rejection and the race could fulfill with a
  // completed result after the deadline.
  let timeoutAbortListener: (() => void) | undefined;
  const timeoutAbortPromise = new Promise<never>((_, reject) => {
    timeoutAbortListener = () => reject(abortErrorFromSignal(timeoutAbortCtrl.signal));
    timeoutAbortCtrl.signal.addEventListener("abort", timeoutAbortListener, { once: true });
  });
  const timeoutListener: () => void = () => {
    cancel();
  };
  timeoutAbortCtrl.signal.addEventListener("abort", timeoutListener, { once: true });
  let externalAbortListener: (() => void) | undefined;
  let externalAbortPromise: Promise<never> | undefined;
  const abortSignal = opts?.abortSignal;
  const composedAbortSignal = abortSignal
    ? AbortSignal.any([timeoutAbortCtrl.signal, abortSignal])
    : timeoutAbortCtrl.signal;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const armTimer = () => {
    clearTimer();
    timer = setTimeout(() => timeoutAbortCtrl.abort(timeoutError), resolvedTimeoutMs);
    timer.unref?.();
  };
  let settled = false;
  const onProgress = () => {
    // Re-arm only while the call is live; a late pulse after settle is a no-op.
    if (!settled && !timeoutAbortCtrl.signal.aborted) {
      armTimer();
    }
  };
  armTimer();
  // Independent absolute ceiling the stall timer can never re-arm: a faulty
  // engine that reports progress forever must not defer the bound indefinitely
  // (the stall budget's documented inverse risk). 10x the stall budget keeps
  // the ceiling generous without a new configuration surface. The product is
  // re-clamped: a stall budget already at the Node-safe timer maximum would
  // otherwise hand setTimeout an overflowing delay that fires immediately.
  const absoluteCeilingMs = resolveTimerTimeoutMs(
    resolvedTimeoutMs * ABSOLUTE_COMPACTION_BUDGET_MULTIPLIER,
    1,
  );
  const absoluteTimer = setTimeout(() => timeoutAbortCtrl.abort(timeoutError), absoluteCeilingMs);
  absoluteTimer.unref?.();

  try {
    if (abortSignal) {
      if (abortSignal.aborted) {
        cancel();
        throw abortErrorFromSignal(abortSignal);
      }
      externalAbortPromise = new Promise((_, reject) => {
        externalAbortListener = () => {
          cancel();
          reject(abortErrorFromSignal(abortSignal));
        };
        abortSignal.addEventListener("abort", externalAbortListener, { once: true });
      });
    }

    const compactPromise = compact(composedAbortSignal, onProgress);
    if (externalAbortPromise) {
      return await Promise.race([compactPromise, timeoutAbortPromise, externalAbortPromise]);
    }
    return await Promise.race([compactPromise, timeoutAbortPromise]);
  } finally {
    settled = true;
    clearTimer();
    clearTimeout(absoluteTimer);
    timeoutAbortCtrl.signal.removeEventListener("abort", timeoutListener);
    if (timeoutAbortListener) {
      timeoutAbortCtrl.signal.removeEventListener("abort", timeoutAbortListener);
    }
    if (externalAbortListener) {
      abortSignal?.removeEventListener("abort", externalAbortListener);
    }
  }
}

/** Parameters for a single {@link ContextEngine.compact} invocation. */
type ContextEngineCompactParams = Parameters<ContextEngine["compact"]>[0];

/**
 * Invoke a plugin-owned {@link ContextEngine.compact} bounded by the same
 * finite safety timeout that protects native runtime compaction.
 *
 * Plugin context engines that advertise `ownsCompaction` previously had their
 * `compact()` awaited with no timeout, no watchdog, and no abort signal — a
 * slow or hung plugin compaction would hang the agent turn indefinitely. This
 * wrapper closes that gap:
 *  - the call is bounded by `timeoutMs` (host-resolved, default
 *    {@link EMBEDDED_COMPACTION_TIMEOUT_MS}); on timeout it rejects with a
 *    "Compaction timed out" error so the caller's existing failure handling
 *    runs instead of hanging;
 *  - the timeout signal and caller `abortSignal` are both raced against the
 *    call (so a non-cooperating engine is still bounded) and threaded into the
 *    `compact()` params (so cooperating engines can cancel their own in-flight
 *    work).
 *
 * Callers keep their existing try/catch — a timeout or abort surfaces as a
 * thrown error, never a silent hang.
 */
export function compactContextEngineWithSafetyTimeout(
  contextEngine: Pick<ContextEngine, "compact">,
  params: ContextEngineCompactParams,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<CompactResult> {
  return compactWithSafetyTimeout(
    (compactAbortSignal, onProgress) =>
      contextEngine.compact({
        ...params,
        ...(compactAbortSignal ? { abortSignal: compactAbortSignal } : {}),
        ...(onProgress ? { onProgress } : {}),
      }),
    timeoutMs,
    abortSignal ? { abortSignal } : undefined,
  );
}

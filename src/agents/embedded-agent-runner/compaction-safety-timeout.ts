/**
 * Wraps compaction calls with a safety timeout and abort cleanup.
 */
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isRuntimeCompactionDelegate } from "../../context-engine/delegate.js";
import type { CompactResult, ContextEngine } from "../../context-engine/types.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { runAbortableTimeout } from "../../node-host/with-timeout.js";

const EMBEDDED_COMPACTION_TIMEOUT_MS = 180_000;

function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = "reason" in signal ? signal.reason : undefined;
  if (reason instanceof Error) {
    return reason;
  }
  return createAbortError("aborted", reason ? { cause: reason } : undefined);
}

async function raceCompactionWithAbortSignal<T>(
  compact: () => Promise<T>,
  abortSignal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!abortSignal) {
    return await compact();
  }
  if (abortSignal.aborted) {
    onAbort?.();
    throw abortErrorFromSignal(abortSignal);
  }
  let abortListener!: () => void;
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => {
      onAbort?.();
      reject(abortErrorFromSignal(abortSignal));
    };
    abortSignal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([compact(), abortPromise]);
  } finally {
    abortSignal.removeEventListener("abort", abortListener);
  }
}

export function resolveCompactionTimeoutMs(cfg?: OpenClawConfig): number {
  return (
    finiteSecondsToTimerSafeMilliseconds(cfg?.agents?.defaults?.compaction?.timeoutSeconds, {
      floorSeconds: true,
    }) ?? EMBEDDED_COMPACTION_TIMEOUT_MS
  );
}

export async function compactWithSafetyTimeout<T>(
  compact: (abortSignal: AbortSignal | undefined, resetTimeout: () => void) => Promise<T>,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
  opts?: {
    abortSignal?: AbortSignal;
    onCancel?: () => void;
  },
): Promise<T> {
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

  return await runAbortableTimeout(
    async (timeoutSignal, resetTimeout) => {
      let timeoutListener: (() => void) | undefined;
      const abortSignal = opts?.abortSignal;
      const composedAbortSignal =
        timeoutSignal && abortSignal
          ? AbortSignal.any([timeoutSignal, abortSignal])
          : (timeoutSignal ?? abortSignal);

      if (timeoutSignal) {
        timeoutListener = () => {
          cancel();
        };
        timeoutSignal.addEventListener("abort", timeoutListener, { once: true });
      }

      try {
        return await raceCompactionWithAbortSignal(
          () => compact(composedAbortSignal, resetTimeout),
          abortSignal,
          cancel,
        );
      } finally {
        if (timeoutListener) {
          timeoutSignal?.removeEventListener("abort", timeoutListener);
        }
      }
    },
    timeoutMs,
    "Compaction",
  );
}

/** Parameters for a single {@link ContextEngine.compact} invocation. */
type ContextEngineCompactParams = Parameters<ContextEngine["compact"]>[0];

/**
 * Invoke {@link ContextEngine.compact} at its timeout ownership boundary.
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
 * The canonical built-in delegate keeps the native runtime's progress-aware
 * watchdog while still racing the caller's abort signal. Every other engine
 * stays host-bounded, including wrappers that do not advertise
 * `ownsCompaction`, so an incomplete or hung implementation cannot silently
 * disable the timeout.
 */
export function compactContextEngineWithSafetyTimeout(
  contextEngine: Pick<ContextEngine, "compact" | "info">,
  params: ContextEngineCompactParams,
  timeoutMs: number = EMBEDDED_COMPACTION_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<CompactResult> {
  if (isRuntimeCompactionDelegate(contextEngine.compact)) {
    return compactWithSafetyTimeout(
      (compactionAbortSignal, resetTimeout) =>
        contextEngine.compact({
          ...params,
          ...(compactionAbortSignal ? { abortSignal: compactionAbortSignal } : {}),
          runtimeContext: {
            ...params.runtimeContext,
            compactionTimeoutReset: resetTimeout,
          },
        }),
      timeoutMs,
      abortSignal ? { abortSignal } : undefined,
    );
  }
  return compactWithSafetyTimeout(
    (compactAbortSignal) =>
      contextEngine.compact(
        compactAbortSignal ? { ...params, abortSignal: compactAbortSignal } : params,
      ),
    timeoutMs,
    abortSignal ? { abortSignal } : undefined,
  );
}

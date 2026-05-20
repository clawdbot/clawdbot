import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompactResult, ContextEngine } from "../../context-engine/types.js";
import { withTimeout } from "../../node-host/with-timeout.js";

export const EMBEDDED_COMPACTION_TIMEOUT_MS = 900_000;

const MAX_SAFE_TIMEOUT_MS = 2_147_000_000;

function createAbortError(signal: AbortSignal): Error {
  const reason = "reason" in signal ? signal.reason : undefined;
  if (reason instanceof Error) {
    return reason;
  }
  const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
  err.name = "AbortError";
  return err;
}

function composeAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length <= 1) {
    return { signal: activeSignals[0], cleanup: () => {} };
  }

  const controller = new AbortController();
  const removers: Array<() => void> = [];

  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort("reason" in signal ? signal.reason : undefined);
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const onAbort = () => abortFrom(signal);
    signal.addEventListener("abort", onAbort, { once: true });
    removers.push(() => signal.removeEventListener("abort", onAbort));
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const remove of removers) {
        remove();
      }
    },
  };
}

export function resolveCompactionTimeoutMs(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.compaction?.timeoutSeconds;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw) * 1000, MAX_SAFE_TIMEOUT_MS);
  }
  return EMBEDDED_COMPACTION_TIMEOUT_MS;
}

export async function compactWithSafetyTimeout<T>(
  compact: (abortSignal?: AbortSignal) => Promise<T>,
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

  return await withTimeout(
    async (timeoutSignal) => {
      let timeoutListener: (() => void) | undefined;
      let externalAbortListener: (() => void) | undefined;
      let externalAbortPromise: Promise<never> | undefined;
      const abortSignal = opts?.abortSignal;
      const composedAbortSignal = composeAbortSignals(timeoutSignal, abortSignal);

      if (timeoutSignal) {
        timeoutListener = () => {
          cancel();
        };
        timeoutSignal.addEventListener("abort", timeoutListener, { once: true });
      }

      if (abortSignal) {
        if (abortSignal.aborted) {
          cancel();
          throw createAbortError(abortSignal);
        }
        externalAbortPromise = new Promise((_, reject) => {
          externalAbortListener = () => {
            cancel();
            reject(createAbortError(abortSignal));
          };
          abortSignal.addEventListener("abort", externalAbortListener, { once: true });
        });
      }

      try {
        const compactPromise = compact(composedAbortSignal.signal);
        if (externalAbortPromise) {
          return await Promise.race([compactPromise, externalAbortPromise]);
        }
        return await compactPromise;
      } finally {
        composedAbortSignal.cleanup();
        if (timeoutListener) {
          timeoutSignal?.removeEventListener("abort", timeoutListener);
        }
        if (externalAbortListener) {
          abortSignal?.removeEventListener("abort", externalAbortListener);
        }
      }
    },
    timeoutMs,
    "Compaction",
  );
}

/** Parameters for a single {@link ContextEngine.compact} invocation. */
export type ContextEngineCompactParams = Parameters<ContextEngine["compact"]>[0];

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
    (compactAbortSignal) =>
      contextEngine.compact(
        compactAbortSignal ? { ...params, abortSignal: compactAbortSignal } : params,
      ),
    timeoutMs,
    abortSignal ? { abortSignal } : undefined,
  );
}

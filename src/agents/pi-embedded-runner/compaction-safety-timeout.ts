import type { OpenClawConfig } from "../../config/types.openclaw.js";
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

export function resolveCompactionTimeoutMs(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.compaction?.timeoutSeconds;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw) * 1000, MAX_SAFE_TIMEOUT_MS);
  }
  return EMBEDDED_COMPACTION_TIMEOUT_MS;
}

export async function compactWithSafetyTimeout<T>(
  compact: () => Promise<T>,
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
        if (externalAbortPromise) {
          return await Promise.race([compact(), externalAbortPromise]);
        }
        return await compact();
      } finally {
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

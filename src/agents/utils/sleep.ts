/**
 * Sleep helper that respects abort signal.
 */
import { resolveTimerTimeoutMs } from "../../shared/number-coercion.js";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Aborted"));
    };
    const timeout = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      resolveTimerTimeoutMs(ms, 0, 0),
    );

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

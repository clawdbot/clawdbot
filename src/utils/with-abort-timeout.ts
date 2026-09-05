import { withTimeout } from "./with-timeout.js";

export async function withAbortTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  message?: string,
): Promise<T> {
  const timeoutController = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    return await withTimeout(run(combinedSignal), timeoutMs, message ? { message } : undefined);
  } finally {
    timeoutController.abort();
  }
}

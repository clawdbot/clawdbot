/**
 * Throws an AbortError if the given signal has been aborted.
 * Use at async checkpoints to support cancellation.
 */
export function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    const err = new Error("Operation aborted");
    err.name = "AbortError";
    throw err;
  }
}

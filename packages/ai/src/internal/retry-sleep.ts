export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }

    // Successful retry waits must detach from the run-level signal; otherwise
    // every retry retains this promise closure until the whole run aborts.
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Request was aborted"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

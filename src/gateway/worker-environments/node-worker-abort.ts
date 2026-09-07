export function raceNodeWorkerOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () =>
    signal.reason instanceof Error ? signal.reason : new Error("node worker operation aborted");
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("node worker operation failed"));
      },
    );
  });
}

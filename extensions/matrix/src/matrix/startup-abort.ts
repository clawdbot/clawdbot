export function createMatrixStartupAbortError(): Error {
  const error = new Error("Matrix startup aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfMatrixStartupAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted === true) {
    throw createMatrixStartupAbortError();
  }
}

export function isMatrixStartupAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function awaitMatrixStartupWithAbort<T>(
  promise: Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  if (!abortSignal) {
    return await promise;
  }
  if (abortSignal.aborted) {
    throw createMatrixStartupAbortError();
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      abortSignal.removeEventListener("abort", onAbort);
      reject(createMatrixStartupAbortError());
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

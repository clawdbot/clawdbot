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
      (error: unknown) => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(toLintErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

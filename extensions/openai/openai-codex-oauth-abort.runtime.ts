export function createOAuthLoginCancelledError(): Error {
  return new Error("Login cancelled");
}

export function throwIfOAuthLoginAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createOAuthLoginCancelledError();
  }
}

export function withOAuthLoginAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      onAbort?.();
      reject(createOAuthLoginCancelledError());
    };

    if (signal.aborted) {
      abort();
      return;
    }

    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

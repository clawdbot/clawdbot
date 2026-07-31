export function createAbortError(message: string, options?: ErrorOptions): Error {
  const error = new Error(message, options);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  if (name === "AbortError") {
    return true;
  }
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return message === "This operation was aborted";
}

/** Resolves when the signal aborts, or immediately when no wait is needed. */
export async function waitForAbortSignal(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      // Remove explicitly even with `{ once: true }`; tests use foreign
      // AbortSignal-like objects, and cleanup must stay deterministic there.
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

import { createAbortError, isAbortError } from "../infra/abort-signal.js";

export function contextEngineAbortSignal(methodParams: unknown): AbortSignal | undefined {
  // SAFETY: host method parameters are read structurally only for the optional abortSignal field.
  const signal = (methodParams as { abortSignal?: unknown } | null | undefined)?.abortSignal;
  if (!signal || typeof signal !== "object" || !("aborted" in signal)) {
    return undefined;
  }
  // SAFETY: the host supplies AbortSignal here; the structural guard above rejects non-signal data.
  const abortSignal = signal as AbortSignal;
  if (!abortSignal.aborted) {
    return abortSignal;
  }
  const reason = abortSignal.reason;
  throw reason instanceof Error
    ? reason
    : createAbortError(String(reason || "Context engine operation aborted."));
}

export function isContextEngineAbortRejection(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  if (!signal?.aborted) {
    return false;
  }
  if (error === signal.reason || isAbortError(error)) {
    return true;
  }
  const seen = new Set<Error>();
  for (
    let current = error;
    current instanceof Error && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    if (current.cause === signal.reason) {
      return true;
    }
  }
  return false;
}

// Shared error helpers for model-list availability fallback behavior.
/** Error code used when model availability lookup is unavailable but auth heuristics can continue. */
export const MODEL_AVAILABILITY_UNAVAILABLE_CODE = "MODEL_AVAILABILITY_UNAVAILABLE";

/** Formats an unknown error with stack detail when available. */
export function formatErrorWithStack(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}

/** Returns true when model list should continue with auth heuristics. */
export function shouldFallbackToAuthHeuristics(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === MODEL_AVAILABILITY_UNAVAILABLE_CODE;
}

/** Canonical thenable guard; use instead of local isPromiseLike copies. */
export function isPromiseLike<T = unknown>(value: unknown): value is PromiseLike<T> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  // A hostile/exotic object can throw from its `then` getter; a guard must
  // classify, never throw (diagnostics streams rely on this).
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}

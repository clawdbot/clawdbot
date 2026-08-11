/** Canonical thenable guard; use instead of local isPromiseLike copies. */
export function isPromiseLike<T = unknown>(value: unknown): value is PromiseLike<T> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/** Returns true when a lifecycle start omits its producer-owned finite timestamp. */
export function hasInvalidLifecycleStartTimestamp(stream: string, data: unknown): boolean {
  if (stream !== "lifecycle" || !data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const lifecycle = data as { phase?: unknown; startedAt?: unknown };
  return (
    lifecycle.phase === "start" &&
    (typeof lifecycle.startedAt !== "number" || !Number.isFinite(lifecycle.startedAt))
  );
}

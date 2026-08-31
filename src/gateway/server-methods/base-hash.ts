/** Read the optional optimistic-write base hash from a gateway method payload. */
export function resolveBaseHashParam(params: unknown): string | null {
  // Base hashes are optimistic-write guards. Treat missing, blank, and
  // non-string values as absent so callers must opt in deliberately.
  const raw = (params as { baseHash?: unknown })?.baseHash;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

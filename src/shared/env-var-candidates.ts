/** Appends normalized, unique environment-variable candidates to a keyed bucket. */
export function appendUniqueEnvVarCandidates(
  target: Record<string, string[]>,
  ownerId: string,
  keys: readonly string[],
): void {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId || keys.length === 0) {
    return;
  }
  const bucket = (target[normalizedOwnerId] ??= []);
  const seen = new Set(bucket);
  for (const key of keys) {
    const normalizedKey = key.trim();
    if (!normalizedKey || seen.has(normalizedKey)) {
      continue;
    }
    seen.add(normalizedKey);
    bucket.push(normalizedKey);
  }
}

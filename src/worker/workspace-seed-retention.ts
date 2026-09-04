export const WORKSPACE_SEED_RETENTION = {
  maxEntries: 6,
  maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  temporaryMaxAgeMs: 60 * 60 * 1_000,
};

type SeedEntry = { name: string; mtimeMs: number };

/** Self-contained so project preparation can embed it before any worker runtime is installed. */
export function selectWorkspaceSeedsToPrune(
  entries: readonly SeedEntry[],
  policy: typeof WORKSPACE_SEED_RETENTION,
  now: number,
  preserveKey: string,
): SeedEntry[] {
  const newest = entries
    .filter((entry) => /^(?:[a-f0-9]{64}|\.tmp-[a-f0-9]{64}-.+)$/u.test(entry.name))
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  // Reserve a slot for the just-prepared seed even when another entry's clock is ahead.
  let retained = newest.some((entry) => entry.name === preserveKey) ? 1 : 0;
  return newest.filter((entry) => {
    if (entry.name === preserveKey) {
      return false;
    }
    const temporary = entry.name.startsWith(".tmp-");
    return (
      now - entry.mtimeMs > (temporary ? policy.temporaryMaxAgeMs : policy.maxAgeMs) ||
      (!temporary && ++retained > policy.maxEntries)
    );
  });
}

type ComparableSubagentRun = {
  runId: string;
  createdAt: number;
  generation?: number;
};

type GenerationalSubagentRun = ComparableSubagentRun & {
  childSessionKey?: string;
};

function normalizeGeneration(entry: ComparableSubagentRun): number {
  return typeof entry.generation === "number" && Number.isFinite(entry.generation)
    ? entry.generation
    : 0;
}

/** Orders runs that share a child session, including legacy rows without a generation. */
export function compareSubagentRunGeneration(
  left: ComparableSubagentRun,
  right: ComparableSubagentRun,
): number {
  const generationDelta = normalizeGeneration(left) - normalizeGeneration(right);
  if (generationDelta !== 0) {
    return generationDelta;
  }
  const createdAtDelta = left.createdAt - right.createdAt;
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }
  return left.runId.localeCompare(right.runId);
}

/** Keeps the newest generation at the grouping key prepared by the caller. */
export function recordLatestSubagentRun<T extends ComparableSubagentRun>(
  map: Map<string, T>,
  key: string,
  entry: T,
): void {
  const existing = map.get(key);
  if (!existing || compareSubagentRunGeneration(entry, existing) > 0) {
    map.set(key, entry);
  }
}

/** Allocates a durable monotonic generation within one child session. */
export function nextSubagentRunGeneration(
  runs: Iterable<GenerationalSubagentRun>,
  childSessionKey: string,
): number {
  let generation = 0;
  for (const entry of runs) {
    if (entry.childSessionKey === childSessionKey) {
      generation = Math.max(generation, normalizeGeneration(entry));
    }
  }
  return generation + 1;
}

function importanceMultiplier(importance: number | null | undefined): number {
  if (importance === null || importance === undefined) {
    return 1;
  }
  const bounded = Math.max(1, Math.min(10, Math.floor(importance)));
  return 0.75 + bounded * 0.05;
}

export function applyImportanceMultiplier<T extends { score: number; importance?: number }>(
  results: T[],
): T[] {
  return results.map(applyEntryImportance);
}

function applyEntryImportance<T extends { score: number; importance?: number }>(entry: T): T {
  return {
    ...entry,
    score: entry.score * importanceMultiplier(entry.importance),
  };
}

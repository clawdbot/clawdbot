import { INVALID_PROJECT_ANNOTATION_KEY } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type ProjectRankable = {
  score: number;
  projectKey?: string;
};

export function projectScoreMultiplier(
  projectKey: string | null | undefined,
  activeProjectKeys: readonly string[] | undefined,
): number {
  if (!projectKey || !activeProjectKeys || activeProjectKeys.length === 0) {
    return 1;
  }
  const active = new Set(activeProjectKeys);
  const stored = projectKey
    .split(";")
    .map((key) => key.trim())
    .filter(Boolean);
  return stored.every((key) => active.has(key)) ? 1.15 : 0.9;
}

export function applyProjectRanking<T extends ProjectRankable>(
  results: readonly T[],
  activeProjectKeys?: readonly string[],
): T[] {
  const eligible = results.filter(
    (entry) =>
      !entry.projectKey
        ?.split(";")
        .map((key) => key.trim())
        .includes(INVALID_PROJECT_ANNOTATION_KEY),
  );
  if (!activeProjectKeys || activeProjectKeys.length === 0) {
    return eligible;
  }
  // Retrieval owners sort after score adjustment, preserving their exact-match tiers.
  return eligible.map((entry) =>
    Object.assign({}, entry, {
      score: entry.score * projectScoreMultiplier(entry.projectKey, activeProjectKeys),
    }),
  );
}

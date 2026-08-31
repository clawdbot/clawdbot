export const DEFAULT_PROGRESS_DRAFT_LABELS = ["Working"] as const;

function hashProgressSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function selectProgressLabel(params: {
  labels?: readonly string[];
  seed?: string;
  random?: () => number;
}): string | undefined {
  const labels = params.labels ?? DEFAULT_PROGRESS_DRAFT_LABELS;
  if (labels.length === 0) {
    return undefined;
  }
  const index =
    typeof params.seed === "string" && params.seed.length > 0
      ? hashProgressSeed(params.seed) % labels.length
      : Math.floor(Math.max(0, Math.min(0.999999, params.random?.() ?? 0)) * labels.length);
  return labels[index] ?? labels[0];
}

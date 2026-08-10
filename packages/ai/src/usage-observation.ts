import type { Usage } from "./types.js";

export type CachedInputObservation = { state: "exact"; tokens: number } | { state: "unknown" };

const cachedInputObservationByUsage = new WeakMap<Usage, CachedInputObservation>();

function readTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER)
    : undefined;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Resolve cache-read authority from raw provider usage, never normalized zero defaults. */
export function cachedInputObservationFromRawUsage(rawUsage: unknown): CachedInputObservation {
  if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
    return { state: "unknown" };
  }
  const usage = rawUsage as Record<string, unknown>;
  const directCandidates = [
    ownValue(usage, "cache_read_input_tokens"),
    ownValue(usage, "cached_tokens"),
  ];
  for (const candidate of directCandidates) {
    if (candidate !== undefined) {
      const tokens = readTokenCount(candidate);
      return tokens === undefined ? { state: "unknown" } : { state: "exact", tokens };
    }
  }
  for (const detailsKey of ["input_tokens_details", "prompt_tokens_details"]) {
    const details = ownValue(usage, detailsKey);
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      continue;
    }
    const cachedTokens = ownValue(details as Record<string, unknown>, "cached_tokens");
    if (cachedTokens !== undefined) {
      const tokens = readTokenCount(cachedTokens);
      return tokens === undefined ? { state: "unknown" } : { state: "exact", tokens };
    }
  }
  return { state: "unknown" };
}

export function bindCachedInputObservation(
  usage: Usage,
  observation: CachedInputObservation,
): Usage {
  cachedInputObservationByUsage.set(usage, observation);
  return usage;
}

export function resolveCachedInputObservation(usage: unknown): CachedInputObservation {
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const bound = cachedInputObservationByUsage.get(usage as Usage);
    if (bound) {
      return bound;
    }
  }
  return cachedInputObservationFromRawUsage(usage);
}

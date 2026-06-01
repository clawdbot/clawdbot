/** Upper bound for config path array indexes to reject impractical sparse writes. */
export const MAX_CONFIG_PATH_ARRAY_INDEX = 100_000;

const CANONICAL_ARRAY_INDEX_SEGMENT = /^(0|[1-9]\d*)$/;

/** Parses a canonical non-negative array index segment used by config and JSON paths. */
export function parseConfigPathArrayIndex(segment: string): number | undefined {
  if (!CANONICAL_ARRAY_INDEX_SEGMENT.test(segment)) {
    return undefined;
  }
  const index = Number(segment);
  return Number.isSafeInteger(index) && index <= MAX_CONFIG_PATH_ARRAY_INDEX ? index : undefined;
}

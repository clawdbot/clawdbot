import { expectDefined } from "@openclaw/normalization-core";

export function levenshteinDistance(left: string, right: string): number;
export function levenshteinDistance(
  left: string,
  right: string,
  maxDistance: number,
): number | null;
export function levenshteinDistance(
  left: string,
  right: string,
  maxDistance?: number,
): number | null {
  if (left === right) {
    return 0;
  }
  if (!left || !right) {
    return maxDistance === undefined ? left.length + right.length : null;
  }
  if (maxDistance !== undefined && Math.abs(left.length - right.length) > maxDistance) {
    return null;
  }

  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let index = 0; index <= right.length; index += 1) {
    previous[index] = index;
  }
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    current[0] = leftIndex + 1;
    const leftCode = left.charCodeAt(leftIndex);
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = leftCode === right.charCodeAt(rightIndex) ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        expectDefined(current[rightIndex], "current entry at right index") + 1,
        expectDefined(previous[rightIndex + 1], "previous entry at right index + 1") + 1,
        expectDefined(previous[rightIndex], "previous entry at right index") + cost,
      );
    }
    // Keep cutoff work outside the inner loop used by full-distance callers.
    if (maxDistance !== undefined) {
      let rowMin = Number.POSITIVE_INFINITY;
      for (const distance of current) {
        rowMin = Math.min(rowMin, distance);
      }
      if (rowMin > maxDistance) {
        return null;
      }
    }
    const nextPrevious = current;
    current = previous;
    previous = nextPrevious;
  }
  const distance = expectDefined(previous[right.length], "previous entry at right.length");
  return maxDistance !== undefined && distance > maxDistance ? null : distance;
}

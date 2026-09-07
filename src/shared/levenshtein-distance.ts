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

  const row = new Uint32Array(right.length + 1);
  for (let index = 0; index <= right.length; index += 1) {
    row[index] = index;
  }
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    let diagonal = leftIndex;
    row[0] = leftIndex + 1;
    const leftCode = left.charCodeAt(leftIndex);
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = leftCode === right.charCodeAt(rightIndex) ? 0 : 1;
      // The saved old cell becomes the next column's diagonal after this overwrite.
      const above = expectDefined(row[rightIndex + 1], "previous entry at right index + 1");
      row[rightIndex + 1] = Math.min(
        expectDefined(row[rightIndex], "current entry at right index") + 1,
        above + 1,
        diagonal + cost,
      );
      diagonal = above;
    }
    // Keep cutoff work outside the inner loop used by full-distance callers.
    if (maxDistance !== undefined) {
      let rowMin = Number.POSITIVE_INFINITY;
      for (const distance of row) {
        rowMin = Math.min(rowMin, distance);
      }
      if (rowMin > maxDistance) {
        return null;
      }
    }
  }
  const distance = expectDefined(row[right.length], "previous entry at right.length");
  return maxDistance !== undefined && distance > maxDistance ? null : distance;
}

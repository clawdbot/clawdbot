import { expectDefined } from "@openclaw/normalization-core";
export function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (!left) {
    return right.length;
  }
  if (!right) {
    return left.length;
  }

  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let index = 0; index <= right.length; index += 1) {
    previous[index] = index;
  }
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    current[0] = leftIndex + 1;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        expectDefined(current[rightIndex], "current entry at right index") + 1,
        expectDefined(previous[rightIndex + 1], "previous entry at right index + 1") + 1,
        expectDefined(previous[rightIndex], "previous entry at right index") + cost,
      );
    }
    const nextPrevious = current;
    current = previous;
    previous = nextPrevious;
  }
  return expectDefined(previous[right.length], "previous entry at right.length");
}

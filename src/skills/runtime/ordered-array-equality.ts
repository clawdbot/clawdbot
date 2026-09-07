export const areOrderedArraysEqual = <T>(
  left: readonly T[],
  right: readonly T[],
  equals: (left: T, right: T) => boolean,
): boolean =>
  left.length === right.length && left.every((value, index) => equals(value, right[index]!));

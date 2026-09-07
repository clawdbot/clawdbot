import { describe, expect, it } from "vitest";
import { levenshteinDistance } from "./levenshtein-distance.js";

describe("levenshteinDistance", () => {
  it.each([
    ["", "", 0],
    ["", "abc", 3],
    ["abc", "", 3],
    ["kitten", "sitting", 3],
    ["ab", "ba", 2],
    ["😀", "😃", 1],
    ["😀", "a", 2],
  ] as const)("keeps the full UTF-16 distance from %j to %j", (left, right, expected) => {
    const distance: number = levenshteinDistance(left, right);
    expect(distance).toBe(expected);
  });

  it.each([
    ["", "", 0, 0],
    ["same", "same", 0, 0],
    ["", "abc", 3, null],
    ["abc", "", 3, null],
    ["a", "abcde", 3, null],
    ["kitten", "sitting", 3, 3],
    ["kitten", "sitting", 2, null],
    ["ab", "ba", 1, null],
    ["😀", "😃", 1, 1],
    ["😀", "a", 1, null],
  ] as const)("bounds the distance from %j to %j at %i", (left, right, bound, expected) => {
    expect(levenshteinDistance(left, right, bound)).toBe(expected);
  });
});

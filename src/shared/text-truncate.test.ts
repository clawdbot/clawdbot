import { describe, expect, it } from "vitest";
import { truncateUtf16WithEllipsis } from "./text-truncate.js";

describe("truncateUtf16WithEllipsis", () => {
  it.each([
    { name: "keeps text at the boundary", value: "abcd", maxLength: 4, expected: "abcd" },
    { name: "adds an ellipsis", value: "abcdef", maxLength: 4, expected: "abc…" },
    { name: "returns empty for a negative limit", value: "abc", maxLength: -1, expected: "" },
    { name: "returns empty for a zero limit", value: "abc", maxLength: 0, expected: "" },
    { name: "keeps one safe code unit", value: "abc", maxLength: 1, expected: "a" },
    {
      name: "drops a leading surrogate pair at limit one",
      value: "😀a",
      maxLength: 1,
      expected: "",
    },
    { name: "avoids a dangling surrogate at limit two", value: "😀a", maxLength: 2, expected: "…" },
    {
      name: "avoids a dangling surrogate at larger limits",
      value: "a😀bc",
      maxLength: 3,
      expected: "a…",
    },
    {
      name: "preserves whitespace before the marker",
      value: "ab  cd",
      maxLength: 5,
      expected: "ab  …",
    },
  ])("$name", ({ value, maxLength, expected }) => {
    expect(truncateUtf16WithEllipsis(value, maxLength)).toBe(expected);
  });
});

// Program helper tests cover shared command registration and help helpers.
import { describe, expect, it } from "vitest";
import {
  collectOption,
  parsePositiveIntOrUndefined,
  parseStrictPositiveIntOption,
  parseStrictPositiveIntOrUndefined,
} from "./helpers.js";

describe("program helpers", () => {
  it("collectOption appends values in order", () => {
    expect(collectOption("a")).toEqual(["a"]);
    expect(collectOption("b", ["a"])).toEqual(["a", "b"]);
  });

  it.each([
    { value: undefined, expected: undefined },
    { value: null, expected: undefined },
    { value: "", expected: undefined },
    { value: 5, expected: 5 },
    { value: 5.9, expected: undefined },
    { value: 0, expected: undefined },
    { value: -1, expected: undefined },
    { value: Number.NaN, expected: undefined },
    { value: "10", expected: 10 },
    { value: "10ms", expected: undefined },
    { value: "1.5", expected: undefined },
    { value: "0", expected: undefined },
    { value: "nope", expected: undefined },
    { value: true, expected: undefined },
  ])("parsePositiveIntOrUndefined(%j)", ({ value, expected }) => {
    expect(parsePositiveIntOrUndefined(value)).toBe(expected);
  });

  it.each([
    { value: undefined, expected: undefined },
    { value: null, expected: undefined },
    { value: "", expected: undefined },
    { value: 5, expected: 5 },
    { value: 5.9, expected: undefined },
    { value: 0, expected: undefined },
    { value: -1, expected: undefined },
    { value: Number.NaN, expected: undefined },
    { value: "10", expected: 10 },
    { value: " 10 ", expected: 10 },
    { value: "+10", expected: 10 },
    { value: "10ms", expected: undefined },
    { value: "1.5", expected: undefined },
    { value: "0", expected: undefined },
    { value: "nope", expected: undefined },
    { value: true, expected: undefined },
  ])("parseStrictPositiveIntOrUndefined(%j)", ({ value, expected }) => {
    expect(parseStrictPositiveIntOrUndefined(value)).toBe(expected);
  });

  it("parseStrictPositiveIntOption rejects partial numeric strings", () => {
    expect(parseStrictPositiveIntOption("10", "--limit")).toBe(10);
    expect(() => parseStrictPositiveIntOption("10ms", "--limit")).toThrow(
      "--limit must be a positive integer.",
    );
  });
});

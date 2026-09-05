import { describe, expect, it } from "vitest";
import { hasAnyNonEmptyString } from "./delivery-evidence-values.js";

describe("hasAnyNonEmptyString", () => {
  it.each([
    { name: "undefined", value: undefined, expected: false },
    { name: "scalar text", value: "ready", expected: false },
    { name: "empty array", value: [], expected: false },
    { name: "blank strings", value: ["", " \n "], expected: false },
    { name: "mixed values without text", value: [null, 1, {}, []], expected: false },
    { name: "nested text", value: [["ready"]], expected: false },
    { name: "non-empty text", value: ["", " ready "], expected: true },
    { name: "mixed values with text", value: [null, "ready", 1], expected: true },
  ])("returns $expected for $name", ({ value, expected }) => {
    expect(hasAnyNonEmptyString(value)).toBe(expected);
  });

  it("does not mutate mixed delivery evidence", () => {
    const value: unknown[] = ["", { text: "nested" }, " ready ", null];
    const before = value.slice();

    expect(hasAnyNonEmptyString(value)).toBe(true);
    expect(value).toEqual(before);
  });
});

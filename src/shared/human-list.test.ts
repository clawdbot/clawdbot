// Tests for human-readable list formatting.
import { describe, expect, it } from "vitest";
import { formatHumanList } from "./human-list.js";

describe("formatHumanList", () => {
  it("returns empty string for empty array", () => {
    expect(formatHumanList([])).toBe("");
  });

  it("returns the value for single element", () => {
    expect(formatHumanList(["apple"])).toBe("apple");
  });

  it("joins two elements with or", () => {
    expect(formatHumanList(["apple", "banana"])).toBe("apple or banana");
  });

  it("joins three elements with comma and or", () => {
    expect(formatHumanList(["apple", "banana", "cherry"])).toBe("apple, banana, or cherry");
  });

  it("joins four or more elements", () => {
    expect(formatHumanList(["a", "b", "c", "d"])).toBe("a, b, c, or d");
  });
});

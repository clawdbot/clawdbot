// Program helper tests cover shared command registration and help helpers.
import { describe, expect, it } from "vitest";
import { collectOption, parseStrictPositiveIntOption } from "./helpers.js";

describe("program helpers", () => {
  it("collectOption appends values in order", () => {
    expect(collectOption("a")).toEqual(["a"]);
    expect(collectOption("b", ["a"])).toEqual(["a", "b"]);
  });

  it("parseStrictPositiveIntOption rejects partial numeric strings", () => {
    expect(parseStrictPositiveIntOption("10", "--limit")).toBe(10);
    expect(() => parseStrictPositiveIntOption("10ms", "--limit")).toThrow(
      "--limit must be a positive integer.",
    );
  });
});

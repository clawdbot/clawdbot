import { describe, expect, it } from "vitest";
import { summarizeStringEntries } from "./string-sample.js";

describe("summarizeStringEntries", () => {
  it("returns emptyText for empty lists", () => {
    expect(summarizeStringEntries({ entries: [], emptyText: "any" })).toBe("any");
    expect(summarizeStringEntries({ entries: null })).toBe("");
  });

  it("joins short lists without a suffix", () => {
    expect(summarizeStringEntries({ entries: ["a", "b"], limit: 4 })).toBe("a, b");
  });

  it("adds a remainder suffix when truncating", () => {
    expect(
      summarizeStringEntries({
        entries: ["a", "b", "c", "d", "e"],
        limit: 4,
      }),
    ).toBe("a, b, c, d (+1)");
  });

  it("uses a floored limit and clamps non-positive values to one entry", () => {
    expect(
      summarizeStringEntries({
        entries: ["a", "b", "c"],
        limit: 2.8,
      }),
    ).toBe("a, b (+1)");
    expect(
      summarizeStringEntries({
        entries: ["a", "b", "c"],
        limit: 0,
      }),
    ).toBe("a (+2)");
  });

  it("uses the default limit when none is provided", () => {
    expect(
      summarizeStringEntries({
        entries: ["a", "b", "c", "d", "e", "f", "g"],
      }),
    ).toBe("a, b, c, d, e, f (+1)");
  });

  it("uses the default limit for non-finite limits", () => {
    expect(
      summarizeStringEntries({
        entries: ["a", "b", "c", "d", "e", "f", "g"],
        limit: Number.NaN,
      }),
    ).toBe("a, b, c, d, e, f (+1)");
  });

  it("does not add a suffix when the limit exactly matches the entry count", () => {
    expect(
      summarizeStringEntries({
        entries: ["a", "b", "c"],
        limit: 3,
        emptyText: "ignored",
      }),
    ).toBe("a, b, c");
  });
});

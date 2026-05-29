import { describe, expect, it } from "vitest";
import { normalizeTimestamp } from "./date-time.js";

describe("normalizeTimestamp", () => {
  it("normalizes numeric second and millisecond timestamps", () => {
    expect(normalizeTimestamp("1700000000")).toEqual({
      timestampMs: 1_700_000_000_000,
      timestampUtc: "2023-11-14T22:13:20.000Z",
    });
    expect(normalizeTimestamp("1700000000000")).toEqual({
      timestampMs: 1_700_000_000_000,
      timestampUtc: "2023-11-14T22:13:20.000Z",
    });
  });

  it("ignores unsafe or out-of-range numeric timestamp strings", () => {
    expect(normalizeTimestamp("9007199254740993")).toBeUndefined();
    expect(normalizeTimestamp("999999999999999999999999")).toBeUndefined();
  });
});

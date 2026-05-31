import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateStamp, normalizeTimestamp } from "./date-time.js";

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

describe("formatDateStamp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back when nowMs is outside Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));

    expect(formatDateStamp(8_640_000_000_000_001, "UTC")).toBe("2026-05-30");
  });

  it("falls back to epoch when both nowMs and Date.now are outside Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    expect(formatDateStamp(8_640_000_000_000_001, "UTC")).toBe("1970-01-01");
  });
});

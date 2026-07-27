// Covers date-stamp formatting fallbacks.
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateStamp } from "./date-time.js";

describe("formatDateStamp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back when nowMs is outside Date range", () => {
    // Runtime callers can pass invalid epoch values; Date.now is the safe
    // fallback when still within Date's supported range.
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));

    expect(formatDateStamp(8_640_000_000_000_001, "UTC")).toBe("2026-05-30");
  });

  it("falls back to epoch when both nowMs and Date.now are outside Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    expect(formatDateStamp(8_640_000_000_000_001, "UTC")).toBe("1970-01-01");
  });
});

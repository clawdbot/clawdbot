// Timestamp validation tests cover cron timestamp parsing and stale value rejection.
import { describe, expect, it, vi } from "vitest";
import { validateScheduleTimestamp } from "./validate-timestamp.js";

describe("validateScheduleTimestamp", () => {
  it("falls back instead of throwing for invalid validation clocks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T12:00:00.000Z"));
    try {
      const result = validateScheduleTimestamp(
        { kind: "at", at: "2026-02-23T11:00:00.000Z" },
        Number.POSITIVE_INFINITY,
      );

      expect(result).toEqual({
        ok: false,
        message:
          "schedule.at is in the past: 2026-02-23T11:00:00.000Z (60 minutes ago). Current time: 2026-02-23T12:00:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects at timestamps more than ten years ahead", () => {
    const result = validateScheduleTimestamp(
      { kind: "at", at: "2037-01-01T00:00:00.000Z" },
      Date.parse("2026-01-01T00:00:00.000Z"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("schedule.at is too far in the future");
      expect(result.message).toContain("2037-01-01T00:00:00.000Z");
    }
  });
});

// Covers cron-style current-time formatting and invalid Date fallbacks.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCronStyleNow } from "./current-time.js";

describe("resolveCronStyleNow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back when nowMs is outside Date range", () => {
    // Invalid scheduler timestamps should fall back to wall-clock time so cron
    // prompts still get a usable reference date.
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00.000Z"));

    const result = resolveCronStyleNow(
      { agents: { defaults: { userTimezone: "UTC", timeFormat: "24" } } },
      8_640_000_000_000_001,
    );

    expect(result.formattedTime).toBe("Saturday, May 30th, 2026 - 12:00");
    expect(result.timeLine).toContain("Reference UTC: 2026-05-30 12:00 UTC");
  });

  it("falls back to epoch when both nowMs and Date.now are outside Date range", () => {
    // If both inputs are invalid, epoch is the deterministic last resort.
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    const result = resolveCronStyleNow(
      { agents: { defaults: { userTimezone: "UTC", timeFormat: "24" } } },
      8_640_000_000_000_001,
    );

    expect(result.timeLine).toContain("Reference UTC: 1970-01-01 00:00 UTC");
  });
});

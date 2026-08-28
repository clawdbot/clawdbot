// Covers heartbeat active-hours evaluation.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isWithinActiveHours } from "./heartbeat-active-hours.js";

function cfgWithUserTimezone(userTimezone = "UTC"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        userTimezone,
      },
    },
  };
}

function heartbeatWindow(start: string, end: string, timezone: string) {
  return {
    activeHours: {
      start,
      end,
      timezone,
    },
  };
}

describe("isWithinActiveHours", () => {
  it("returns true when activeHours is not configured", () => {
    expect(
      isWithinActiveHours(cfgWithUserTimezone("UTC"), undefined, Date.UTC(2025, 0, 1, 3)),
    ).toBe(true);
  });

  it("returns true when activeHours start/end are invalid", () => {
    const cfg = cfgWithUserTimezone("UTC");
    expect(
      isWithinActiveHours(cfg, heartbeatWindow("bad", "10:00", "UTC"), Date.UTC(2025, 0, 1, 9)),
    ).toBe(true);
    expect(
      isWithinActiveHours(cfg, heartbeatWindow("08:00", "24:30", "UTC"), Date.UTC(2025, 0, 1, 9)),
    ).toBe(true);
  });

  it("returns false when activeHours start equals end", () => {
    const cfg = cfgWithUserTimezone("UTC");
    expect(
      isWithinActiveHours(
        cfg,
        heartbeatWindow("08:00", "08:00", "UTC"),
        Date.UTC(2025, 0, 1, 12, 0, 0),
      ),
    ).toBe(false);
  });

  it("respects user timezone windows for normal ranges", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = heartbeatWindow("08:00", "24:00", "user");

    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 7, 0, 0))).toBe(false);
    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 8, 0, 0))).toBe(true);
    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 23, 59, 0))).toBe(true);
  });

  it("supports overnight ranges", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = heartbeatWindow("22:00", "06:00", "UTC");

    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 23, 0, 0))).toBe(true);
    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 5, 30, 0))).toBe(true);
    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 12, 0, 0))).toBe(false);
  });

  it("respects explicit non-user timezones", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = heartbeatWindow("09:00", "17:00", "America/New_York");

    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 15, 0, 0))).toBe(true);
    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 23, 30, 0))).toBe(false);
  });

  it("falls back to user timezone when activeHours timezone is invalid", () => {
    const cfg = cfgWithUserTimezone("UTC");
    const heartbeat = heartbeatWindow("08:00", "10:00", "Mars/Olympus");

    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 9, 0, 0))).toBe(true);
    expect(isWithinActiveHours(cfg, heartbeat, Date.UTC(2025, 0, 1, 11, 0, 0))).toBe(false);
  });
});

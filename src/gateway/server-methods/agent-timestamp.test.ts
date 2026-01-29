import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";

describe("injectTimestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Wednesday, January 28, 2026 at 8:30 PM EST
    vi.setSystemTime(new Date("2026-01-29T01:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prepends a formatted timestamp to a plain message", () => {
    const result = injectTimestamp("Is it the weekend?", {
      timezone: "America/New_York",
      timeFormat: "12",
    });

    expect(result).toMatch(/^\[.+\] Is it the weekend\?$/);
    expect(result).toContain("Wednesday");
    expect(result).toContain("January 28");
    expect(result).toContain("2026");
    expect(result).toContain("8:30 PM");
  });

  it("formats in 24-hour time when configured", () => {
    const result = injectTimestamp("hello", {
      timezone: "America/New_York",
      timeFormat: "24",
    });

    expect(result).toContain("20:30");
    expect(result).not.toContain("PM");
  });

  it("uses the configured timezone", () => {
    const result = injectTimestamp("hello", {
      timezone: "America/Chicago",
      timeFormat: "12",
    });

    // 8:30 PM EST = 7:30 PM CST
    expect(result).toContain("7:30 PM");
  });

  it("defaults to UTC when no timezone specified", () => {
    const result = injectTimestamp("hello", {});

    // 2026-01-29T01:30:00Z
    expect(result).toContain("January 29"); // UTC date, not EST
    expect(result).toContain("1:30 AM");
  });

  it("returns empty/whitespace messages unchanged", () => {
    expect(injectTimestamp("", { timezone: "UTC" })).toBe("");
    expect(injectTimestamp("   ", { timezone: "UTC" })).toBe("   ");
  });

  it("does NOT double-stamp messages with channel envelope timestamps", () => {
    const enveloped = "[Discord user1 2026-01-28 20:30 EST] hello there";
    const result = injectTimestamp(enveloped, { timezone: "America/New_York" });

    expect(result).toBe(enveloped);
  });

  it("does NOT double-stamp messages with cron-injected timestamps", () => {
    const cronMessage =
      "[cron:abc123 my-job] do the thing\nCurrent time: Wednesday, January 28th, 2026 — 8:30 PM (America/New_York)";
    const result = injectTimestamp(cronMessage, { timezone: "America/New_York" });

    expect(result).toBe(cronMessage);
  });

  it("handles midnight correctly", () => {
    vi.setSystemTime(new Date("2026-02-01T05:00:00.000Z")); // midnight EST

    const result = injectTimestamp("hello", {
      timezone: "America/New_York",
      timeFormat: "12",
    });

    expect(result).toContain("February 1");
    expect(result).toContain("12:00 AM");
  });

  it("handles date boundaries (just before midnight)", () => {
    vi.setSystemTime(new Date("2026-02-01T04:59:00.000Z")); // 11:59 PM Jan 31 EST

    const result = injectTimestamp("hello", {
      timezone: "America/New_York",
      timeFormat: "12",
    });

    expect(result).toContain("January 31");
    expect(result).toContain("11:59 PM");
  });

  it("handles DST correctly (same UTC hour, different local time)", () => {
    // EST (winter): UTC-5 → 2026-01-15T05:00Z = midnight Jan 15
    vi.setSystemTime(new Date("2026-01-15T05:00:00.000Z"));
    const winter = injectTimestamp("winter", {
      timezone: "America/New_York",
      timeFormat: "12",
    });
    expect(winter).toContain("January 15");
    expect(winter).toContain("12:00 AM");

    // EDT (summer): UTC-4 → 2026-07-15T04:00Z = midnight Jul 15
    vi.setSystemTime(new Date("2026-07-15T04:00:00.000Z"));
    const summer = injectTimestamp("summer", {
      timezone: "America/New_York",
      timeFormat: "12",
    });
    expect(summer).toContain("July 15");
    expect(summer).toContain("12:00 AM");
  });

  it("accepts a custom now date", () => {
    const customDate = new Date("2025-07-04T16:00:00.000Z"); // July 4, noon EST

    const result = injectTimestamp("fireworks?", {
      timezone: "America/New_York",
      timeFormat: "12",
      now: customDate,
    });

    expect(result).toContain("July 4");
    expect(result).toContain("2025");
  });
});

describe("timestampOptsFromConfig", () => {
  it("extracts timezone and timeFormat from config", () => {
    const opts = timestampOptsFromConfig({
      agents: {
        defaults: {
          userTimezone: "America/Chicago",
          timeFormat: "24",
        },
      },
    } as any);

    expect(opts.timezone).toBe("America/Chicago");
    expect(opts.timeFormat).toBe("24");
  });

  it("falls back gracefully with empty config", () => {
    const opts = timestampOptsFromConfig({} as any);

    expect(opts.timezone).toBeDefined(); // resolveUserTimezone provides a default
    expect(opts.timeFormat).toBeUndefined();
  });
});

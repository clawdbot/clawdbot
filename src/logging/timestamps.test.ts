// Timestamp tests cover timezone validation and timestamp formatting.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { formatLocalIsoWithOffset, formatTimestamp, isValidTimeZone } from "./timestamps.js";

describe("formatLocalIsoWithOffset", () => {
  const testDate = new Date("2025-01-01T04:00:00.000Z");

  it("produces +00:00 offset for UTC", () => {
    const result = formatLocalIsoWithOffset(testDate, "UTC");
    expect(result).toBe("2025-01-01T04:00:00.000+00:00");
  });

  it("produces +08:00 offset for Asia/Shanghai", () => {
    const result = formatLocalIsoWithOffset(testDate, "Asia/Shanghai");
    expect(result).toBe("2025-01-01T12:00:00.000+08:00");
  });

  it("produces correct offset for America/New_York", () => {
    const result = formatLocalIsoWithOffset(testDate, "America/New_York");
    // January is EST = UTC-5
    expect(result).toBe("2024-12-31T23:00:00.000-05:00");
  });

  it("produces correct offset for America/New_York in summer (EDT)", () => {
    const summerDate = new Date("2025-07-01T12:00:00.000Z");
    const result = formatLocalIsoWithOffset(summerDate, "America/New_York");
    // July is EDT = UTC-4
    expect(result).toBe("2025-07-01T08:00:00.000-04:00");
  });

  it("outputs a valid ISO 8601 string with offset", () => {
    const result = formatLocalIsoWithOffset(testDate, "Asia/Shanghai");
    // ISO 8601 with offset: YYYY-MM-DDTHH:MM:SS.mmm±HH:MM
    const iso8601WithOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;
    expect(result).toMatch(iso8601WithOffset);
  });

  it("falls back gracefully for an invalid timezone", () => {
    const result = formatLocalIsoWithOffset(testDate, "not-a-tz");
    const iso8601WithOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;
    expect(result).toMatch(iso8601WithOffset);
  });

  it("does NOT use getHours, getMinutes, getTimezoneOffset in the implementation", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "timestamps.ts"), "utf-8");
    expect(source).not.toMatch(/\.getHours\s*\(/);
    expect(source).not.toMatch(/\.getMinutes\s*\(/);
    expect(source).not.toMatch(/\.getTimezoneOffset\s*\(/);
  });
});

describe("formatTimestamp", () => {
  const testDate = new Date("2024-01-15T14:30:45.123Z");

  it("formats short style with explicit UTC offset", () => {
    expect(formatTimestamp(testDate, { style: "short", timeZone: "UTC" })).toBe("14:30:45+00:00");
  });

  it("formats medium style with milliseconds and offset", () => {
    expect(formatTimestamp(testDate, { style: "medium", timeZone: "UTC" })).toBe(
      "14:30:45.123+00:00",
    );
  });

  it.each(["UTC", "America/New_York", "Europe/Paris"])(
    "matches formatLocalIsoWithOffset for long style in %s",
    (timeZone) => {
      expect(formatTimestamp(testDate, { style: "long", timeZone })).toBe(
        formatLocalIsoWithOffset(testDate, timeZone),
      );
    },
  );

  it("falls back to a valid offset when the timezone is invalid", () => {
    expect(formatTimestamp(testDate, { style: "short", timeZone: "not-a-tz" })).toMatch(
      /^\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
  });
});

describe("isValidTimeZone", () => {
  it("returns true for valid IANA timezones", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
  });

  it("returns false for invalid timezone strings", () => {
    expect(isValidTimeZone("not-a-tz")).toBe(false);
    expect(isValidTimeZone("yo agent's")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

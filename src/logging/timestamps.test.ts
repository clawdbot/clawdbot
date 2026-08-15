// Timestamp tests cover timestamp formatting and timezone fallback behavior.
import { describe, expect, it } from "vitest";
import { formatTimestamp } from "./timestamps.js";

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

  it.each([
    ["UTC", "2024-01-15T14:30:45.123+00:00"],
    ["America/New_York", "2024-01-15T09:30:45.123-05:00"],
    ["Europe/Paris", "2024-01-15T15:30:45.123+01:00"],
  ])("formats long style in %s", (timeZone, expected) => {
    expect(formatTimestamp(testDate, { style: "long", timeZone })).toBe(expected);
  });

  it("falls back to a valid offset when the timezone is invalid", () => {
    expect(formatTimestamp(testDate, { style: "short", timeZone: "not-a-tz" })).toMatch(
      /^\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
  });
});

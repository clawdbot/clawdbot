import { describe, expect, it } from "vitest";
import { hasValidIsoCalendarComponents } from "./iso-time.js";

describe("hasValidIsoCalendarComponents", () => {
  it.each([
    "2026-07-05",
    "2028-02-29T12:30Z",
    "2028-02-29T12:30:45.123456+01:30",
    "2028-02-29T24:00:00Z",
    "2028-02-29T24:00:00.0000Z",
  ])("accepts valid calendar components in %s", (value) => {
    expect(hasValidIsoCalendarComponents(value)).toBe(true);
  });

  it.each([
    "2026-02-29",
    "2026-11-31T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-07-05T24:00:00.001Z",
    "2026-07-05T24:00:00.0001Z",
    "2026-07-05T12:60:00Z",
    "2026-07-05T12:00:60Z",
    "2026-7-05",
  ])("rejects invalid calendar components or shape in %s", (value) => {
    expect(hasValidIsoCalendarComponents(value)).toBe(false);
  });
});

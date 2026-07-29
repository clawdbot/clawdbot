// Covers offsetless ISO datetime detection, timezone conversion, DST gaps, and
// sub-second round trips.
import { describe, expect, it } from "vitest";
import {
  isOffsetlessIsoDateTime,
  parseOffsetlessIsoDateTimeInTimeZone,
} from "./parse-offsetless-zoned-datetime.js";

describe("parseOffsetlessIsoDateTimeInTimeZone", () => {
  it.each([
    ["2026-03-23T23:00:00", true],
    ["2026-03-23T23:00:00+02:00", false],
    ["+20m", false],
  ])("detects offset-less ISO datetime %s", (input, expected) => {
    expect(isOffsetlessIsoDateTime(input)).toBe(expected);
  });

  it.each([
    ["2026-03-23T23:00:00", "Europe/Oslo", "2026-03-23T22:00:00.000Z"],
    ["2026-03-29T01:30:00", "Europe/Oslo", "2026-03-29T00:30:00.000Z"],
    ["2026-03-29T02:30:00", "Europe/Oslo", null],
    ["2026-03-23T23:00:00+02:00", "Europe/Oslo", null],
    ["2026-03-23T23:00:00", "Invalid/Timezone", null],
    // Sub-second precision is accepted by the regex and must round-trip rather
    // than being silently rejected (the offset must be computed at ms resolution).
    ["2026-03-23T23:00:00.250", "UTC", "2026-03-23T23:00:00.250Z"],
    ["2026-03-23T23:00:00.999", "UTC", "2026-03-23T23:00:00.999Z"],
    ["2026-03-23T23:00:00.123", "Europe/Oslo", "2026-03-23T22:00:00.123Z"],
  ])("parses zoned datetime %s in %s", (input, timezone, expected) => {
    expect(parseOffsetlessIsoDateTimeInTimeZone(input, timezone)).toBe(expected);
  });
});

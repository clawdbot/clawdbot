// Covers offsetless ISO datetime detection, timezone conversion, DST gaps, and
// sub-second round trips.
import { describe, expect, it } from "vitest";
import {
  isOffsetlessIsoDateTime,
  parseOffsetlessIsoDateTimeInTimeZone,
} from "./parse-offsetless-zoned-datetime.js";

describe("parseOffsetlessIsoDateTimeInTimeZone", () => {
  it.each([
    ["2026-03-23", true],
    ["2026-03-23T23:00:00", true],
    ["2026-03-23t23:00:00", true],
    ["2027-02-28T24:00:00", true],
    ["2027-02-28t24:00", true],
    ["2027-02-28t24:00:00.000", true],
    ["2026-03-23Z", false],
    ["2026-03-23T23:00:00+02:00", false],
    ["+20m", false],
  ])("detects offset-less ISO datetime %s", (input, expected) => {
    expect(isOffsetlessIsoDateTime(input)).toBe(expected);
  });

  it.each([
    ["2026-03-23", "UTC", "2026-03-23T00:00:00.000Z"],
    ["2026-03-23", "Asia/Shanghai", "2026-03-22T16:00:00.000Z"],
    ["2026-03-23", "America/New_York", "2026-03-23T04:00:00.000Z"],
    ["2011-12-30", "Pacific/Apia", null],
    ["2026-03-23T23:00:00", "Europe/Oslo", "2026-03-23T22:00:00.000Z"],
    ["2026-03-23t23:00:00", "Europe/Oslo", "2026-03-23T22:00:00.000Z"],
    ["2026-03-23T00:00:00", "UTC", "2026-03-23T00:00:00.000Z"],
    ["2026-03-23T00:30:00", "UTC", "2026-03-23T00:30:00.000Z"],
    ["2026-03-23T00:30:00.250", "UTC", "2026-03-23T00:30:00.250Z"],
    ["2026-03-23T00:30:00", "Europe/Oslo", "2026-03-22T23:30:00.000Z"],
    ["2026-03-29T01:30:00", "Europe/Oslo", "2026-03-29T00:30:00.000Z"],
    ["2026-03-29T02:30:00", "Europe/Oslo", null],
    ["2026-10-25T02:30:00", "Europe/Oslo", "2026-10-25T00:30:00.000Z"],
    ["2026-11-01T01:30:00", "America/New_York", "2026-11-01T05:30:00.000Z"],
    ["2026-04-05T01:45:00", "Australia/Lord_Howe", "2026-04-04T14:45:00.000Z"],
    ["2026-10-04T02:15:00", "Australia/Lord_Howe", null],
    ["2026-03-23T23:00:00+02:00", "Europe/Oslo", null],
    ["2026-03-23T23:00:00", "Invalid/Timezone", null],
    // Sub-second precision is accepted by the regex and must round-trip rather
    // than being silently rejected (the offset must be computed at ms resolution).
    ["2026-03-23T23:00:00.250", "UTC", "2026-03-23T23:00:00.250Z"],
    ["2026-03-23T23:00:00.999", "UTC", "2026-03-23T23:00:00.999Z"],
    ["2026-03-23T23:00:00.123", "Europe/Oslo", "2026-03-23T22:00:00.123Z"],
    ["2026-10-25T02:30:00.250", "Europe/Oslo", "2026-10-25T00:30:00.250Z"],
  ])("parses zoned datetime %s in %s", (input, timezone, expected) => {
    expect(parseOffsetlessIsoDateTimeInTimeZone(input, timezone)).toBe(expected);
  });

  it.each([
    ["2027-02-28T24:00:00", "UTC", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28T24:00:00.000", "UTC", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28t24:00", "UTC", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28t24:00:00", "UTC", "2027-03-01T00:00:00.000Z"],
    ["2027-02-28t24:00:00.000", "Europe/Oslo", "2027-02-28T23:00:00.000Z"],
    ["2027-02-28T24:00:00", "America/New_York", "2027-03-01T05:00:00.000Z"],
    ["2027-02-28T24:00:00", "Europe/Oslo", "2027-02-28T23:00:00.000Z"],
    ["2027-03-13T24:00:00", "America/New_York", "2027-03-14T05:00:00.000Z"],
    ["2027-03-14T24:00:00", "America/New_York", "2027-03-15T04:00:00.000Z"],
    ["2027-03-14t24:00", "America/New_York", "2027-03-15T04:00:00.000Z"],
    ["2027-11-06T24:00:00", "America/New_York", "2027-11-07T04:00:00.000Z"],
    ["2027-11-07T24:00:00", "America/New_York", "2027-11-08T05:00:00.000Z"],
    ["2027-03-27T24:00:00", "Europe/Oslo", "2027-03-27T23:00:00.000Z"],
    ["2027-03-28T24:00:00", "Europe/Oslo", "2027-03-28T22:00:00.000Z"],
    ["2027-10-30T24:00:00", "Europe/Oslo", "2027-10-30T22:00:00.000Z"],
    ["2027-10-31T24:00:00", "Europe/Oslo", "2027-10-31T23:00:00.000Z"],
  ])(
    "rolls valid end-of-day datetime %s into the next local day in %s",
    (input, timezone, expected) => {
      expect(parseOffsetlessIsoDateTimeInTimeZone(input, timezone)).toBe(expected);
    },
  );

  it.each([
    ["2027-02-28T24:01:00", "UTC"],
    ["2027-02-28t24:01", "UTC"],
    ["2027-02-28T24:00:01", "America/New_York"],
    ["2027-02-28T24:00:00.001", "Europe/Oslo"],
    ["2027-02-28t24:00:00.001", "Europe/Oslo"],
    ["2027-02-28T24:00:00.0001", "UTC"],
    ["2027-02-29T24:00:00", "UTC"],
    ["2027-09-04T24:00:00", "America/Santiago"],
  ])("rejects invalid or nonexistent end-of-day datetime %s in %s", (input, timezone) => {
    expect(parseOffsetlessIsoDateTimeInTimeZone(input, timezone)).toBeNull();
  });
});

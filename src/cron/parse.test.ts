// Cron parse tests cover CLI and config parsing for scheduled jobs.
import { describe, expect, it } from "vitest";
import { parseAbsoluteTimeMs } from "./parse.js";

describe("parseAbsoluteTimeMs", () => {
  describe("epoch milliseconds", () => {
    it("parses positive epoch milliseconds", () => {
      expect(parseAbsoluteTimeMs("1700000000000")).toBe(1_700_000_000_000);
    });

    it("rejects digit-only timestamps outside the Date range", () => {
      expect(parseAbsoluteTimeMs(String(Number.MAX_SAFE_INTEGER))).toBeNull();
    });

    it("rejects negative epoch milliseconds", () => {
      // Negative numbers don't match /^\d+$/ pattern, so they're parsed as dates
      // "-1000" is interpreted as a date string by Date.parse()
      // This tests that very old timestamps outside valid range are rejected
      expect(parseAbsoluteTimeMs("-8640000000000001")).toBeNull();
    });

    it("rejects non-numeric strings that look like numbers", () => {
      expect(parseAbsoluteTimeMs("123abc")).toBeNull();
    });
  });

  describe("ISO 8601 date only", () => {
    it("parses date only as midnight UTC", () => {
      expect(parseAbsoluteTimeMs("2024-01-15")).toBe(Date.parse("2024-01-15T00:00:00Z"));
    });

    it("parses date with implicit Z suffix", () => {
      expect(parseAbsoluteTimeMs("2024-06-01")).toBe(Date.parse("2024-06-01T00:00:00Z"));
    });
  });

  describe("ISO 8601 datetime without timezone", () => {
    it("parses datetime without timezone as UTC", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00")).toBe(Date.parse("2024-01-15T10:30:00Z"));
    });

    it("parses datetime with seconds as UTC", () => {
      expect(parseAbsoluteTimeMs("2024-03-20T15:45:30")).toBe(Date.parse("2024-03-20T15:45:30Z"));
    });
  });

  describe("ISO 8601 with Z (UTC) timezone", () => {
    it("parses datetime with Z suffix", () => {
      const expected = Date.parse("2024-01-15T10:30:00Z");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00Z")).toBe(expected);
    });

    it("parses datetime with lowercase z suffix", () => {
      const expected = Date.parse("2024-01-15T10:30:00Z");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00z")).toBe(expected);
    });

    it("parses RFC 3339 lowercase t and z separators", () => {
      const expected = Date.parse("2024-01-15T10:30:00Z");
      expect(parseAbsoluteTimeMs("2024-01-15t10:30:00z")).toBe(expected);
    });

    it("parses datetime with milliseconds and Z", () => {
      const expected = Date.parse("2024-01-15T10:30:45.123Z");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:45.123Z")).toBe(expected);
    });

    it("parses datetime with microseconds and Z", () => {
      // JavaScript Date has millisecond precision, but should parse without error
      const expected = Date.parse("2024-01-15T10:30:45.123456Z");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:45.123456Z")).toBe(expected);
    });

    it("parses datetime with nanoseconds and Z (truncates to ms)", () => {
      const expected = Date.parse("2024-01-15T10:30:45.123456789Z");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:45.123456789Z")).toBe(expected);
    });
  });

  describe("ISO 8601 with timezone offset (colon format)", () => {
    it("parses datetime with positive offset +HH:MM", () => {
      // UTC+8 (Beijing/Singapore)
      const expected = Date.parse("2024-01-15T10:30:00+08:00");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+08:00")).toBe(expected);
    });

    it("parses datetime with negative offset -HH:MM", () => {
      // UTC-5 (EST)
      const expected = Date.parse("2024-01-15T10:30:00-05:00");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00-05:00")).toBe(expected);
    });

    it("parses datetime with zero offset +00:00", () => {
      const expected = Date.parse("2024-01-15T10:30:00+00:00");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+00:00")).toBe(expected);
    });

    it("parses datetime with maximum positive offset +14:00", () => {
      const expected = Date.parse("2024-01-15T10:30:00+14:00");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+14:00")).toBe(expected);
    });

    it("parses datetime with maximum negative offset -12:00", () => {
      const expected = Date.parse("2024-01-15T10:30:00-12:00");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00-12:00")).toBe(expected);
    });

    it("parses datetime with half-hour offset +05:30", () => {
      // India Standard Time
      const expected = Date.parse("2024-01-15T10:30:00+05:30");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+05:30")).toBe(expected);
    });

    it("parses datetime with 45-minute offset +12:45", () => {
      // New Zealand Chatham Islands
      const expected = Date.parse("2024-01-15T10:30:00+12:45");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+12:45")).toBe(expected);
    });
  });

  describe("ISO 8601 with timezone offset (no colon format)", () => {
    it("parses datetime with positive offset +HHMM", () => {
      const expected = Date.parse("2024-01-15T10:30:00+0800");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+0800")).toBe(expected);
    });

    it("parses datetime with negative offset -HHMM", () => {
      const expected = Date.parse("2024-01-15T10:30:00-0500");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00-0500")).toBe(expected);
    });

    it("parses datetime with zero offset +0000", () => {
      const expected = Date.parse("2024-01-15T10:30:00+0000");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+0000")).toBe(expected);
    });
  });

  describe("ISO 8601 with milliseconds and timezone", () => {
    it("parses datetime with milliseconds and positive offset", () => {
      const expected = Date.parse("2024-01-15T10:30:45.500+08:00");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:45.500+08:00")).toBe(expected);
    });

    it("parses datetime with milliseconds and negative offset", () => {
      const expected = Date.parse("2024-01-15T10:30:45.999-05:00");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:45.999-05:00")).toBe(expected);
    });

    it("parses datetime with microseconds and timezone", () => {
      const expected = Date.parse("2024-01-15T10:30:45.123456+08:00");
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:45.123456+08:00")).toBe(expected);
    });
  });

  describe("whitespace handling", () => {
    it("trims leading and trailing whitespace", () => {
      expect(parseAbsoluteTimeMs("  1700000000000  ")).toBe(1_700_000_000_000);
      expect(parseAbsoluteTimeMs("  2024-01-15T10:30:00Z  ")).toBe(
        Date.parse("2024-01-15T10:30:00Z"),
      );
    });

    it("rejects strings with only whitespace", () => {
      expect(parseAbsoluteTimeMs("")).toBeNull();
      expect(parseAbsoluteTimeMs("   ")).toBeNull();
    });
  });

  describe("invalid formats", () => {
    it("rejects invalid date strings", () => {
      expect(parseAbsoluteTimeMs("not-a-date")).toBeNull();
      expect(parseAbsoluteTimeMs("2024-13-40")).toBeNull();
      expect(parseAbsoluteTimeMs("invalid")).toBeNull();
    });

    it("rejects truly malformed date strings", () => {
      // JavaScript Date.parse is very lenient, so we test only truly invalid formats
      expect(parseAbsoluteTimeMs("24-01-15")).toBeNull(); // Two-digit year too ambiguous
      expect(parseAbsoluteTimeMs("not-a-date")).toBeNull();
      expect(parseAbsoluteTimeMs("")).toBeNull();
    });

    it("rejects non-padded ISO-like date formats", () => {
      expect(parseAbsoluteTimeMs("2024-1-15")).toBeNull();
    });

    it("rejects incomplete datetime strings", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T")).toBeNull();
      expect(parseAbsoluteTimeMs("2024-01-15T10")).toBeNull();
    });

    it("rejects invalid timezone formats", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+8:00")).toBeNull();
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00+080")).toBeNull();
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:00GMT")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles leap year dates", () => {
      expect(parseAbsoluteTimeMs("2024-02-29T00:00:00Z")).toBe(Date.parse("2024-02-29T00:00:00Z"));
    });

    it("handles year boundary dates", () => {
      expect(parseAbsoluteTimeMs("2023-12-31T23:59:59Z")).toBe(Date.parse("2023-12-31T23:59:59Z"));
      expect(parseAbsoluteTimeMs("2024-01-01T00:00:00Z")).toBe(Date.parse("2024-01-01T00:00:00Z"));
    });

    it("handles edge of valid timestamp range", () => {
      // JavaScript Date range is approximately -100,000,000 to +100,000,000 days
      // Test timestamps well within the valid range that are realistic for cron usage
      const year2000 = new Date("2000-01-01T00:00:00Z").getTime();
      expect(parseAbsoluteTimeMs(year2000.toString())).toBe(year2000);

      const year2050 = new Date("2050-01-01T00:00:00Z").getTime();
      expect(parseAbsoluteTimeMs(year2050.toString())).toBe(year2050);
    });

    it("handles maximum valid timestamp", () => {
      // JavaScript Date range ends at +100,000,000 days
      const maxValid = new Date(8640000000000000).getTime();
      expect(parseAbsoluteTimeMs(maxValid.toString())).toBe(maxValid);
    });
  });

  describe("real-world cron examples", () => {
    it("parses common cron scheduling timestamps", () => {
      // Daily at midnight UTC
      expect(parseAbsoluteTimeMs("2024-01-01T00:00:00Z")).toBe(Date.parse("2024-01-01T00:00:00Z"));

      // Hourly at the top of the hour
      expect(parseAbsoluteTimeMs("2024-06-15T12:00:00+00:00")).toBe(
        Date.parse("2024-06-15T12:00:00+00:00"),
      );

      // Specific business hours in different timezones
      expect(parseAbsoluteTimeMs("2024-03-01T09:00:00+08:00")).toBe(
        Date.parse("2024-03-01T09:00:00+08:00"),
      );
    });

    it("parses timestamps with sub-second precision for high-frequency jobs", () => {
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:45.001Z")).toBe(
        Date.parse("2024-01-15T10:30:45.001Z"),
      );
      expect(parseAbsoluteTimeMs("2024-01-15T10:30:45.999Z")).toBe(
        Date.parse("2024-01-15T10:30:45.999Z"),
      );
    });
  });

  it("parses ISO timestamps with UTC defaults and explicit offsets", () => {
    expect(parseAbsoluteTimeMs("2026-02-28")).toBe(Date.parse("2026-02-28T00:00:00Z"));
    expect(parseAbsoluteTimeMs("2026-02-28T12:34:56.789Z")).toBe(
      Date.parse("2026-02-28T12:34:56.789Z"),
    );
    expect(parseAbsoluteTimeMs("2026-02-28T24:00:00Z")).toBe(Date.parse("2026-02-28T24:00:00Z"));
    expect(parseAbsoluteTimeMs("2026-02-28T12:34:56+08:00")).toBe(
      Date.parse("2026-02-28T12:34:56+08:00"),
    );
  });

  it.each([
    "2023-02-29",
    "2026-02-31",
    "2026-02-31T00:00:00Z",
    "2026-04-31T12:34:56Z",
    "2026-01-01T25:00:00Z",
    "December 17, 2026 03:24:00",
    "2026/12/17",
  ])("rejects invalid absolute timestamp %s", (input) => {
    expect(parseAbsoluteTimeMs(input)).toBeNull();
  });
});

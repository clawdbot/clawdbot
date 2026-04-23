import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatUtcTimestamp, formatZonedTimestamp, resolveTimezone } from "./format-datetime.js";
import {
  formatDurationCompact,
  formatDurationHuman,
  formatDurationPrecise,
  formatDurationSeconds,
} from "./format-duration.js";
import { formatTimeAgo, formatRelativeTimestamp } from "./format-relative.js";

const invalidDurationInputs = [null, undefined, -100] as const;

function expectFormatterCases<TInput, TOutput>(
  formatter: (value: TInput) => TOutput,
  cases: ReadonlyArray<{ input: TInput; expected: TOutput }>,
) {
  for (const { input, expected } of cases) {
    expect(formatter(input), String(input)).toBe(expected);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("format-duration", () => {
  describe("formatDurationCompact", () => {
    it.each([null, undefined, 0, -100])("returns undefined for %j", (value) => {
      expect(formatDurationCompact(value)).toBeUndefined();
    });

    it("formats compact units and omits trailing zero components", () => {
      expectFormatterCases(formatDurationCompact, [
        { input: 500, expected: "500ms" },
        { input: 999, expected: "999ms" },
        { input: 1000, expected: "1s" },
        { input: 45000, expected: "45s" },
        { input: 59000, expected: "59s" },
        { input: 60000, expected: "1m" },
        { input: 65000, expected: "1m5s" },
        { input: 90000, expected: "1m30s" },
        { input: 3600000, expected: "1h" },
        { input: 3660000, expected: "1h1m" },
        { input: 5400000, expected: "1h30m" },
        { input: 86400000, expected: "1d" },
        { input: 90000000, expected: "1d1h" },
        { input: 172800000, expected: "2d" },
      ]);
    });

    it.each([
      { input: 65000, options: { spaced: true }, expected: "1m 5s" },
      { input: 3660000, options: { spaced: true }, expected: "1h 1m" },
      { input: 90000000, options: { spaced: true }, expected: "1d 1h" },
      { input: 59500, expected: "1m" },
      { input: 59400, expected: "59s" },
    ])("formats compact duration for %j", ({ input, options, expected }) => {
      expect(formatDurationCompact(input, options)).toBe(expected);
    });
  });

  describe("formatDurationHuman", () => {
    it("returns fallback for invalid duration input", () => {
      for (const value of invalidDurationInputs) {
        expect(formatDurationHuman(value)).toBe("n/a");
      }
      expect(formatDurationHuman(null, "unknown")).toBe("unknown");
    });

    it("formats single-unit outputs and day threshold behavior", () => {
      expectFormatterCases(formatDurationHuman, [
        { input: 500, expected: "500ms" },
        { input: 5000, expected: "5s" },
        { input: 180000, expected: "3m" },
        { input: 7200000, expected: "2h" },
        { input: 23 * 3600000, expected: "23h" },
        { input: 24 * 3600000, expected: "1d" },
        { input: 25 * 3600000, expected: "1d" },
        { input: 172800000, expected: "2d" },
      ]);
    });
  });

  describe("formatDurationPrecise", () => {
    it.each([
      { input: 500, expected: "500ms" },
      { input: 999, expected: "999ms" },
      { input: -1, expected: "0ms" },
      { input: -500, expected: "0ms" },
      { input: 999.6, expected: "1000ms" },
      { input: 1000, expected: "1s" },
      { input: 1500, expected: "1.5s" },
      { input: 1234, expected: "1.23s" },
      { input: Number.NaN, expected: "unknown" },
      { input: Infinity, expected: "unknown" },
    ])("formats precise duration for %j", ({ input, expected }) => {
      expect(formatDurationPrecise(input)).toBe(expected);
    });
  });

  describe("formatDurationSeconds", () => {
    it.each([
      { input: 1500, options: { decimals: 1 }, expected: "1.5s" },
      { input: 1234, options: { decimals: 2 }, expected: "1.23s" },
      { input: 1000, options: { decimals: 0 }, expected: "1s" },
      { input: 2000, options: { unit: "seconds" as const }, expected: "2 seconds" },
      { input: -1500, options: { decimals: 1 }, expected: "0s" },
      { input: Number.NaN, options: undefined, expected: "unknown" },
      { input: Infinity, options: undefined, expected: "unknown" },
    ])("formats seconds duration for %j", ({ input, options, expected }) => {
      expect(formatDurationSeconds(input, options)).toBe(expected);
    });
  });
});

describe("format-datetime", () => {
  describe("resolveTimezone", () => {
    it.each([
      { input: "America/New_York", expected: "America/New_York" },
      { input: "Europe/London", expected: "Europe/London" },
      { input: "UTC", expected: "UTC" },
      { input: "Invalid/Timezone", expected: undefined },
      { input: "garbage", expected: undefined },
      { input: "", expected: undefined },
    ] as const)("resolves $input", ({ input, expected }) => {
      expect(resolveTimezone(input)).toBe(expected);
    });
  });

  describe("formatUtcTimestamp", () => {
    it.each([
      { displaySeconds: false, expected: "2024-01-15T14:30Z" },
      { displaySeconds: true, expected: "2024-01-15T14:30:45Z" },
    ])("formats UTC timestamp (displaySeconds=$displaySeconds)", ({ displaySeconds, expected }) => {
      const date = new Date("2024-01-15T14:30:45.000Z");
      const result = displaySeconds
        ? formatUtcTimestamp(date, { displaySeconds: true })
        : formatUtcTimestamp(date);
      expect(result).toBe(expected);
    });
  });

  describe("formatZonedTimestamp", () => {
    it.each([
      {
        date: new Date("2024-01-15T14:30:00.000Z"),
        options: { timeZone: "UTC" },
        expected: /2024-01-15 14:30/,
      },
      {
        date: new Date("2024-01-15T14:30:45.000Z"),
        options: { timeZone: "UTC", displaySeconds: true },
        expected: /2024-01-15 14:30:45/,
      },
    ] as const)("formats zoned timestamp", ({ date, options, expected }) => {
      const result = formatZonedTimestamp(date, options);
      expect(result).toMatch(expected);
    });

    it("returns undefined when required Intl parts are missing", () => {
      function MissingPartsDateTimeFormat() {
        return {
          formatToParts: () => [
            { type: "month", value: "01" },
            { type: "day", value: "15" },
            { type: "hour", value: "14" },
            { type: "minute", value: "30" },
          ],
        } as Intl.DateTimeFormat;
      }

      vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
        MissingPartsDateTimeFormat as unknown as typeof Intl.DateTimeFormat,
      );

      expect(formatZonedTimestamp(new Date("2024-01-15T14:30:00.000Z"), { timeZone: "UTC" })).toBe(
        undefined,
      );
    });

    it("returns undefined when Intl formatting throws", () => {
      function ThrowingDateTimeFormat() {
        return {
          formatToParts: () => {
            throw new Error("boom");
          },
        } as unknown as Intl.DateTimeFormat;
      }

      vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
        ThrowingDateTimeFormat as unknown as typeof Intl.DateTimeFormat,
      );

      expect(formatZonedTimestamp(new Date("2024-01-15T14:30:00.000Z"), { timeZone: "UTC" })).toBe(
        undefined,
      );
    });
  });
});

describe("format-relative", () => {
  describe("formatTimeAgo", () => {
    it("returns fallback for invalid elapsed input", () => {
      for (const value of invalidDurationInputs) {
        expect(formatTimeAgo(value)).toBe("unknown");
      }
      expect(formatTimeAgo(null, { fallback: "n/a" })).toBe("n/a");
    });

    it("formats relative age around key unit boundaries", () => {
      expectFormatterCases(formatTimeAgo, [
        { input: 0, expected: "just now" },
        { input: 29000, expected: "just now" },
        { input: 30000, expected: "1m ago" },
        { input: 300000, expected: "5m ago" },
        { input: 7200000, expected: "2h ago" },
        { input: 47 * 3600000, expected: "47h ago" },
        { input: 48 * 3600000, expected: "2d ago" },
        { input: 172800000, expected: "2d ago" },
      ]);
    });

    it.each([
      { input: 0, expected: "0s" },
      { input: 300000, expected: "5m" },
      { input: 7200000, expected: "2h" },
    ])("omits suffix for %j when disabled", ({ input, expected }) => {
      expect(formatTimeAgo(input, { suffix: false })).toBe(expected);
    });
  });

  describe("formatRelativeTimestamp", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-02-10T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns fallback for invalid timestamp input", () => {
      for (const value of [null, undefined]) {
        expect(formatRelativeTimestamp(value)).toBe("n/a");
      }
      expect(formatRelativeTimestamp(null, { fallback: "unknown" })).toBe("unknown");
    });

    it.each([
      { offsetMs: -10000, expected: "just now" },
      { offsetMs: -30000, expected: "just now" },
      { offsetMs: -300000, expected: "5m ago" },
      { offsetMs: -7200000, expected: "2h ago" },
      { offsetMs: -(47 * 3600000), expected: "47h ago" },
      { offsetMs: -(48 * 3600000), expected: "2d ago" },
      { offsetMs: 30000, expected: "in <1m" },
      { offsetMs: 300000, expected: "in 5m" },
      { offsetMs: 7200000, expected: "in 2h" },
    ])("formats relative timestamp for offset $offsetMs", ({ offsetMs, expected }) => {
      expect(formatRelativeTimestamp(Date.now() + offsetMs)).toBe(expected);
    });

    it.each([
      {
        name: "keeps 7-day-old timestamps relative",
        offsetMs: -7 * 24 * 3600000,
        options: { dateFallback: true, timezone: "UTC" },
        expected: "7d ago",
      },
      {
        name: "falls back to a short date once the timestamp is older than 7 days",
        offsetMs: -8 * 24 * 3600000,
        options: { dateFallback: true, timezone: "UTC" },
        expected: "Feb 2",
      },
      {
        name: "keeps relative output when date fallback is disabled",
        offsetMs: -8 * 24 * 3600000,
        options: { timezone: "UTC" },
        expected: "8d ago",
      },
    ])("$name", ({ offsetMs, options, expected }) => {
      expect(formatRelativeTimestamp(Date.now() + offsetMs, options)).toBe(expected);
    });

    it("falls back to relative days when date formatting throws", () => {
      expect(
        formatRelativeTimestamp(Date.now() - 8 * 24 * 3600000, {
          dateFallback: true,
          timezone: "Invalid/Timezone",
        }),
      ).toBe("8d ago");
    });
  });
});

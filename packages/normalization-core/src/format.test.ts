import { describe, expect, it } from "vitest";
import { bucketRelativeTimeMs, formatByteSize, formatCompactTokenCount } from "./format.js";

describe("bucketRelativeTimeMs", () => {
  it.each([
    [0, { value: 0, unit: "second" }],
    [59_499, { value: 59, unit: "second" }],
    [59_500, { value: 1, unit: "minute" }],
    [59 * 60_000, { value: 59, unit: "minute" }],
    [60 * 60_000, { value: 1, unit: "hour" }],
    [47 * 3_600_000, { value: 47, unit: "hour" }],
    [48 * 3_600_000, { value: 2, unit: "day" }],
  ] as const)("buckets %sms with nested rounding", (durationMs, expected) => {
    expect(bucketRelativeTimeMs(durationMs)).toEqual(expected);
  });
});

describe("formatByteSize", () => {
  it.each([
    [1024, { style: "iec", maxUnit: "mega", separator: " ", fractionDigits: 1 }, "1.0 KiB"],
    [1024, { style: "legacy-binary", maxUnit: "mega", separator: "", fractionDigits: 1 }, "1.0KB"],
    [
      5 * 1024 * 1024,
      { style: "legacy-binary", maxUnit: "kilo", separator: " ", fractionDigits: 1 },
      "5120.0 KB",
    ],
  ] as const)("formats %s bytes", (bytes, options, expected) => {
    expect(formatByteSize(bytes, options)).toBe(expected);
  });

  it("supports caller-owned dynamic precision and rounding", () => {
    expect(
      formatByteSize(Math.floor(99.6 * 1024 * 1024), {
        style: "legacy-binary",
        maxUnit: "giga",
        separator: " ",
        fractionDigits: (_value, unit) => (unit === "giga" ? 1 : unit === "byte" ? null : 0),
        floorUnits: ["kilo", "mega"],
      }),
    ).toBe("99 MB");
  });
});

describe("formatCompactTokenCount", () => {
  it.each([
    [999_500, { thousandsPrecision: 0 }, "1.0m"],
    [999_500, { thousandsPrecision: 1 }, "999.5k"],
    [999_950, { thousandsPrecision: 1 }, "1.0m"],
    [999_500, { thousandsPrecision: 0, trimTrailingZero: true }, "1m"],
  ] as const)("preserves precision-dependent rollover for %s", (tokens, options, expected) => {
    expect(formatCompactTokenCount(tokens, options)).toBe(expected);
  });

  it.each([
    [999_999_999, "1000M"],
    [1_000_000_000, "1B"],
  ] as const)("selects the billion unit from the unrounded count %s", (tokens, expected) => {
    expect(
      formatCompactTokenCount(tokens, {
        maxUnit: "billion",
        millionsSuffix: "M",
        trimTrailingZero: true,
      }),
    ).toBe(expected);
  });

  it("retains million-only displays for billion-scale counts", () => {
    expect(formatCompactTokenCount(1_000_000_000)).toBe("1000.0m");
  });
});

import { describe, expect, it } from "vitest";
import { formatByteSize } from "./format.js";

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

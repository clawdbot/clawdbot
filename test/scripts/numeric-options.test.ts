import { describe, expect, it } from "vitest";
import {
  parseStrictNonNegativeDecimal,
  readPositiveEnvInt,
} from "../../scripts/lib/numeric-options.mjs";

describe("parseStrictNonNegativeDecimal", () => {
  it.each([
    ["0", 0],
    [" 42 ", 42],
    [42, 42],
  ])("parses canonical decimal value %j", (raw, expected) => {
    expect(parseStrictNonNegativeDecimal(raw, "limit")).toBe(expected);
  });

  it.each(["", "00", "01", "+1", "-1", "1.5", "1e3", "0x10"])(
    "rejects non-canonical value %j",
    (raw) => {
      expect(() => parseStrictNonNegativeDecimal(raw, "limit")).toThrow(
        "limit must be a non-negative integer",
      );
    },
  );

  it("distinguishes unsafe canonical integers", () => {
    expect(() => parseStrictNonNegativeDecimal("9007199254740992", "limit")).toThrow(
      "limit must be a safe integer",
    );
  });
});

describe("readPositiveEnvInt", () => {
  it("uses the fallback for missing or blank values", () => {
    expect(readPositiveEnvInt("LIMIT", {}, 42)).toBe(42);
    expect(readPositiveEnvInt("LIMIT", { LIMIT: "  " }, 42)).toBe(42);
  });

  it("reads strict positive safe integers", () => {
    expect(readPositiveEnvInt("LIMIT", { LIMIT: " 123 " }, 42)).toBe(123);
  });

  it.each(["0", "-1", "1.5", "1e3", "0x10", "9007199254740992"])(
    "rejects invalid value %s",
    (raw) => {
      expect(() => readPositiveEnvInt("LIMIT", { LIMIT: raw }, 42)).toThrow(
        `invalid LIMIT: ${raw}`,
      );
    },
  );
});

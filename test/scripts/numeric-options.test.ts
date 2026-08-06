import { describe, expect, it } from "vitest";
import { readPositiveEnvInt } from "../../scripts/lib/numeric-options.mjs";

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

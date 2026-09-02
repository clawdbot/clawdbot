import { describe, expect, it } from "vitest";
import { parseNonNegativeByteSize } from "./byte-size.js";

describe("parseNonNegativeByteSize", () => {
  it("keeps safe-integer boundaries exact for numeric and string forms", () => {
    expect(parseNonNegativeByteSize(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseNonNegativeByteSize(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseNonNegativeByteSize("2mb")).toBe(2 * 1024 * 1024);
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, String(Number.MAX_SAFE_INTEGER + 1), "9007199254740993"])(
    "rejects unsafe byte size %j",
    (value) => expect(parseNonNegativeByteSize(value)).toBeNull(),
  );
});

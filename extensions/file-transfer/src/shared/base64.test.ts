// File Transfer tests cover strict base64 preflight validation.
import { describe, expect, it } from "vitest";
import { inspectStrictBase64 } from "./base64.js";

describe("inspectStrictBase64", () => {
  it.each([
    ["", 0],
    ["aGk=", 2],
    ["aGk", 2],
    ["+/8=", 2],
    ["-_8=", 2],
  ])("accepts canonical padded, unpadded, and base64url input", (value, expected) => {
    expect(inspectStrictBase64(value)).toBe(expected);
  });

  it.each(["A", "A===", "=AAA", "AA=A", "AAA@@@", "aG k=", "\tAAA="])(
    "rejects malformed input without decoding: %j",
    (value) => {
      expect(inspectStrictBase64(value)).toBeUndefined();
    },
  );
});

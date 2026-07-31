// Memory Host SDK tests cover error formatting and secret redaction.
import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "./error-utils.js";

const TOKEN_CASES = [
  ["leading split", "abcde😀xxxxxxxxwxyz", "abcde...wxyz"],
  ["trailing split", "abcdefghijklm😀xyz", "abcdef...xyz"],
  ["intact leading pair", "abcd😀xxxxxxxxwxyz", "abcd😀...wxyz"],
  ["intact trailing pair", "abcdefghijklmn😀xy", "abcdef...😀xy"],
] as const;

describe("formatErrorMessage", () => {
  it.each(TOKEN_CASES)("masks tokens with a UTF-16-safe %s", (_label, token, masked) => {
    expect(formatErrorMessage(`TOKEN=${token}`)).toBe(`TOKEN=${masked}`);
  });

  it("replaces the captured value literally when key and value repeat", () => {
    expect(formatErrorMessage("LONG_LONG_LONG_TOKEN=LONG_LONG_LONG_TOKEN")).toBe(
      "LONG_LONG_LONG_TOKEN=LONG_L...OKEN",
    );
    expect(formatErrorMessage("TOKEN=$&abcdxxxxxxxxwxyz")).toBe("TOKEN=$&abcd...wxyz");
  });
});

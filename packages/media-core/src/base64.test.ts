import { describe, expect, it } from "vitest";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "./base64.js";

describe("base64 helpers", () => {
  function expectBase64HelperCase<T>(actual: T, expected: T) {
    expect(actual).toBe(expected);
  }

  it.each([
    {
      name: "canonicalizeBase64 normalizes whitespace and keeps valid base64",
      actual: canonicalizeBase64(" SGV s bG8= \n"),
      expected: "SGVsbG8=",
    },
    {
      name: "canonicalizeBase64 rejects invalid base64 characters",
      actual: canonicalizeBase64('SGVsbG8=" onerror="alert(1)'),
      expected: undefined,
    },
    {
      name: "estimateBase64DecodedBytes handles whitespace",
      actual: estimateBase64DecodedBytes("SGV s bG8= \n"),
      expected: 5,
    },
    {
      name: "estimateBase64DecodedBytes handles empty input",
      actual: estimateBase64DecodedBytes(""),
      expected: 0,
    },
  ] as const)("$name", ({ actual, expected }) => {
    expectBase64HelperCase(actual, expected);
  });
});

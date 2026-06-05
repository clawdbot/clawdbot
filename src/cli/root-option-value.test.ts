// Root option value tests cover root CLI option parsing and inherited values.
import { describe, expect, it } from "vitest";
import { takeCliRootOptionValue } from "./root-option-value.js";

describe("takeCliRootOptionValue", () => {
  it("preserves equals signs after the first separator", () => {
    expect(takeCliRootOptionValue("--token=abc=def", undefined)).toEqual({
      value: "abc=def",
      consumedNext: false,
    });
    expect(takeCliRootOptionValue("--token=abc==", undefined)).toEqual({
      value: "abc==",
      consumedNext: false,
    });
  });

  it("treats empty inline values as missing", () => {
    expect(takeCliRootOptionValue("--token=", "fallback")).toEqual({
      value: null,
      consumedNext: false,
    });
  });

  it("continues to consume the next token for space-separated values", () => {
    expect(takeCliRootOptionValue("--token", "abc=def")).toEqual({
      value: "abc=def",
      consumedNext: true,
    });
  });
});

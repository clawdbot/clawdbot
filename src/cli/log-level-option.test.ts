// Log level option tests cover CLI log-level flag parsing and validation.
import { describe, expect, it } from "vitest";
import { parseCliLogLevelOption } from "./log-level-option.js";

describe("parseCliLogLevelOption", () => {
  it.each([
    ["debug", "debug"],
    [" trace ", "trace"],
  ] as const)("accepts allowed log level %p", (input, expected) => {
    expect(parseCliLogLevelOption(input)).toBe(expected);
  });

  it("rejects invalid log levels", () => {
    expect(() => parseCliLogLevelOption("loud")).toThrow("Invalid --log-level");
  });
});

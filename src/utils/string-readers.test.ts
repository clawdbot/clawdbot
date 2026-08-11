import { describe, expect, it } from "vitest";
import { isStringOption, readTrimmedStringAlias } from "./string-readers.js";

describe("string readers", () => {
  it("checks caller-owned string options from arrays and sets", () => {
    const modes = ["off", "auto"] as const;
    const states = new Set(["ready", "done"] as const);

    expect(isStringOption("auto", modes)).toBe(true);
    expect(isStringOption(" AUTO ", modes)).toBe(false);
    expect(isStringOption("done", states)).toBe(true);
    expect(isStringOption(1, modes)).toBe(false);
  });

  it("reads trimmed aliases", () => {
    const record = {
      empty: "",
      spaced: "  value  ",
      fallback: "fallback",
      invalid: 1,
    };

    expect(readTrimmedStringAlias(record, ["invalid", "empty", "spaced", "fallback"])).toBe(
      "value",
    );
    expect(readTrimmedStringAlias(record, ["invalid", "empty"])).toBeUndefined();
  });
});

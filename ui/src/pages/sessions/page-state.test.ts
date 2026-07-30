import { describe, expect, it } from "vitest";
import { parseFilterInteger } from "./page-state.ts";

describe("parseFilterInteger", () => {
  it.each([
    ["60", 60],
    ["+30", 30],
    ["060", 60],
    [" 80 ", 80],
    ["60minutes", undefined],
    ["12.5", undefined],
    ["1e2", undefined],
    ["9007199254740993", undefined],
    ["0", undefined],
    ["-1", undefined],
    ["", undefined],
  ])("parses %j as %s", (value, expected) => {
    expect(parseFilterInteger(value)).toBe(expected);
  });
});

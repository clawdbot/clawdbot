import { describe, expect, it } from "vitest";
import {
  compileSafeRegex,
  compileSafeRegexDetailed,
  hasNestedRepetition,
  testRegexWithBoundedInput,
} from "./safe-regex.js";

describe("safe regex", () => {
  it.each([
    ["(a+)+$", true],
    ["(a|aa)+$", true],
    ["^(?:foo|bar)$", false],
    ["^(ab|cd)+$", false],
    [String.raw`([\w]|[-.])+@([\w]|[-.])+\.\w+`, false],
  ] as const)("classifies nested repetition for %s", (pattern, expected) => {
    expect(hasNestedRepetition(pattern)).toBe(expected);
  });

  it.each([
    ["(a+)+$", null],
    ["(a|aa)+$", null],
    ["(a|aa){2}$", RegExp],
  ] as const)("compiles %s safely", (pattern, expected) => {
    if (expected === null) {
      expect(compileSafeRegex(pattern)).toBeNull();
      return;
    }
    expect(compileSafeRegex(pattern)).toBeInstanceOf(expected);
  });

  it("compiles common safe filter regex", () => {
    const re = compileSafeRegex("^agent:.*:discord:");
    expect(re).toBeInstanceOf(RegExp);
    expect(re?.test("agent:main:discord:channel:123")).toBe(true);
    expect(re?.test("agent:main:telegram:channel:123")).toBe(false);
  });

  it("supports explicit flags", () => {
    const re = compileSafeRegex("token=([A-Za-z0-9]+)", "gi");
    expect(re).toBeInstanceOf(RegExp);
    expect("TOKEN=abcd1234".replace(re as RegExp, "***")).toBe("***");
  });

  it.each([
    ["   ", "empty"],
    ["(a+)+$", "unsafe-nested-repetition"],
    ["(invalid", "invalid-regex"],
    ["^agent:main$", null],
  ] as const)("returns structured reject reason for %s", (pattern, expected) => {
    expect(compileSafeRegexDetailed(pattern).reason).toBe(expected);
  });

  it.each([
    [/^agent:main:discord:/, `agent:main:discord:${"x".repeat(5000)}`, true],
    [/discord:tail$/, `${"x".repeat(5000)}discord:tail`, true],
    [/discord:tail$/, `${"x".repeat(5000)}telegram:tail`, false],
  ] as const)("checks bounded regex windows for %s", (pattern, input, expected) => {
    expect(testRegexWithBoundedInput(pattern, input)).toBe(expected);
  });
});

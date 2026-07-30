// Covers safe-regex checks for risky user-supplied patterns.
import { describe, expect, it } from "vitest";
import {
  compileSafeRegex,
  compileSafeRegexDetailed,
  testRegexWithBoundedInput,
} from "./safe-regex.js";

function expectCompiledRegex(pattern: string, flags?: string): RegExp {
  const re = compileSafeRegex(pattern, flags);
  expect(re).toBeInstanceOf(RegExp);
  if (!re) {
    throw new Error(`Expected ${pattern} to compile safely`);
  }
  return re;
}

describe("safe regex", () => {
  it.each([
    ["(a+)+$", null],
    ["(a|aa)+$", null],
    ["(a|a)*$", null],
    ["(?:a|a)*$", null],
    ["(\\w|\\w)+$", null],
    ["(.|.)*$", null],
    ["(.|a)+$", null],
    ["(\\w|\\d)*$", null],
    ["([a-f]|[d-z])+$", null],
    ["([é]|\\D)*$", null],
    ["(é|É)*$", null, "i"],
    ["((a|a)|(a|a))*$", null],
    ["^(a)(\\1|a)*!$", null],
    ["(a|b)*$", RegExp],
    ["(ab|cd)*$", RegExp],
    ["(cat|dog)+$", RegExp],
    ["(\\d|\\s)*$", RegExp],
    ["([a-f]|[g-z])*$", RegExp],
    ["([\\w]|[-.])+@([\\w]|[-.])+\\.\\w+", RegExp, "gi"],
    ["(a|aa){2}$", RegExp],
    ["(a|a){2}$", RegExp],
  ] as const)("compiles %s safely", (pattern, expected, flags) => {
    if (expected === null) {
      expect(compileSafeRegex(pattern, flags)).toBeNull();
      return;
    }
    expect(compileSafeRegex(pattern, flags)).toBeInstanceOf(expected);
  });

  it("compiles common safe filter regex", () => {
    const re = expectCompiledRegex("^agent:.*:discord:");
    expect(re.test("agent:main:discord:channel:123")).toBe(true);
    expect(re.test("agent:main:telegram:channel:123")).toBe(false);
  });

  it("supports explicit flags", () => {
    const re = expectCompiledRegex("token=([A-Za-z0-9]+)", "gi");
    expect("TOKEN=abcd1234".replace(re, "***")).toBe("***");
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

// Covers safe-regex checks for risky user-supplied patterns.
import { describe, expect, it } from "vitest";
import { DEFAULT_REDACT_PATTERNS } from "../logging/redact-patterns.js";
import {
  compileJsonSchemaPatternRegexDetailed,
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
    ["(a|aa){2}$", RegExp],
  ] as const)("compiles %s safely", (pattern, expected) => {
    if (expected === null) {
      expect(compileSafeRegex(pattern)).toBeNull();
      return;
    }
    expect(compileSafeRegex(pattern)).toBeInstanceOf(expected);
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

  it("compiles JSON Schema patterns without trimming significant spaces", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed(" a");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test(" a")).toBe(true);
  });

  it("rejects nested-repetition JSON Schema patterns", () => {
    expect(compileJsonSchemaPatternRegexDetailed("(a+)+$").reason).toBe("unsafe-nested-repetition");
  });

  it("rejects sequential unbounded overlapping repetitions (a*a*$)", () => {
    expect(compileSafeRegexDetailed("a*a*$").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexDetailed("a+a+").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("a*a*$").reason).toBe("unsafe-nested-repetition");
  });

  it("still accepts sequential unbounded on different single-char literals (a*b*)", () => {
    expect(compileSafeRegexDetailed("a*b*$").reason).toBeNull();
  });

  it("rejects adjacent sequential class quantifiers without a separator", () => {
    expect(compileSafeRegexDetailed("[ \\t]*[ \\t]*").reason).toBe("unsafe-nested-repetition");
  });

  it("accepts sequential class quantifiers when a fixed separator sits between them", () => {
    expect(
      compileSafeRegexDetailed(String.raw`[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`).reason,
    ).toBeNull();
  });

  it("still compiles every default log redaction pattern", () => {
    const rejected = DEFAULT_REDACT_PATTERNS.filter(
      (pattern) => compileSafeRegexDetailed(pattern, "gi").reason !== null,
    );
    expect(rejected).toEqual([]);
  });
});

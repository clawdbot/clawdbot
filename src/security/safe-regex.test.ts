// Covers safe-regex checks for risky user-supplied patterns.
import { describe, expect, it } from "vitest";
import { DEFAULT_REDACT_PATTERNS } from "../logging/redact-patterns.js";
import { tokenizePattern } from "./safe-regex-tokens.js";
import {
  compileSafeRegex,
  compileSafeRegexDetailed,
  compileSafeRegexForExec,
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
    ["(a|a)+$", null],
    ["(?:a|aa)+$", null],
    ["(?:a|a)+$", null],
    ["(?:(a|a))+$", null],
    ["(aa|a.)+$", null],
    ["([ab]|a.)+$", null],
    ["(a|b)+$", RegExp],
    ["(\\w|\\d)+$", null],
    ["^(\\w|\\d)+$", null],
    ["([\\w]|[-.])+$", RegExp],
    ["([a-z]|[0-9])+$", RegExp],
    ["(?:a|b)+$", RegExp],
    ["(aa|bb)+$", RegExp],
    ["^(ab|ac)+$", RegExp],
    // Disjoint unequal-length alts under + are not ReDoS (not length-diff alone).
    ["(a|bc)+$", RegExp],
    ["^(?:a|bc)+$", RegExp],
    ["(a|aa){2}$", RegExp],
    ["(a|a){2}$", RegExp],
    ["(aa|a.){2}$", RegExp],
  ] as const)("compiles %s safely", (pattern, expected) => {
    if (expected === null) {
      expect(compileSafeRegex(pattern)).toBeNull();
      return;
    }
    expect(compileSafeRegex(pattern)).toBeInstanceOf(expected);
  });

  it("rejects ignore-case overlapping alternatives with locale-independent folding", () => {
    // JS `i` matching is not process-locale dependent; Turkish locale must not
    // accept ^(I|i)+$ as disjoint.
    expect(compileSafeRegex("^(I|i)+$", "i")).toBeNull();
    expect(compileSafeRegexDetailed("^(I|i)+$", "i").reason).toBe("unsafe-nested-repetition");
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

  it("trims shared compiler source (whitespace contract for non-exec callers)", () => {
    const padded = compileSafeRegexDetailed(" a ");
    expect(padded.source).toBe("a");
    expect(padded.regex?.source).toBe("a");
    expect(padded.regex?.test("a")).toBe(true);

    // Shared trim turns "\ " into "\", which is invalid — that is intentional.
    // Exec path (compileExecArgPattern) keeps the original source.
    const escapedSpace = String.raw`\ `;
    const escapedResult = compileSafeRegexDetailed(escapedSpace);
    expect(escapedResult.reason).toBe("invalid-regex");
    expect(escapedResult.source).toBe("\\");
  });

  it.each([
    ["   ", "empty"],
    ["(a+)+$", "unsafe-nested-repetition"],
    ["(a|a)+$", "unsafe-nested-repetition"],
    ["(aa|a.)+$", "unsafe-nested-repetition"],
    ["(invalid", "invalid-regex"],
    ["^agent:main$", null],
  ] as const)("returns structured reject reason for %s", (pattern, expected) => {
    expect(compileSafeRegexDetailed(pattern).reason).toBe(expected);
  });

  it("shared compiler accepts disjoint unprobed Unicode classes", () => {
    // Group-mention style alts must not be banned by a shared finite-probe fallback.
    const pattern = "^(?:[猫]|[犬])+$";
    expect(compileSafeRegexDetailed(pattern).reason).toBeNull();
    expect(compileSafeRegex(pattern)).toBeInstanceOf(RegExp);
  });

  it("exec-style fail-closed rejects unprobed Unicode single-token alts", () => {
    const pattern = String.raw`^(?:[\u0100]|\u0100)+$`;
    const shared = compileSafeRegexDetailed(pattern);
    // Shared path stays two-arg and does not fail closed on unprobed Unicode.
    const execMode = compileSafeRegexForExec(pattern);
    expect(execMode.reason).toBe("unsafe-nested-repetition");
    expect(execMode.regex).toBeNull();
    void shared;
  });

  it("rejects adjacent Unicode property repeats as one atom", () => {
    const overlapping = String.raw`^\p{L}*\p{L}*\p{L}*z$`;
    const tokens = tokenizePattern(overlapping).filter((token) => token.kind === "simple-token");
    expect(tokens.map((token) => token.source)).toEqual([
      "^",
      String.raw`\p{L}`,
      String.raw`\p{L}`,
      String.raw`\p{L}`,
      "z",
      "$",
    ]);
    expect(compileSafeRegex(overlapping)).toBeNull();
    expect(compileSafeRegexDetailed(overlapping, "u").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexForExec(overlapping, "u").regex).toBeNull();
    expect(compileSafeRegex(String.raw`\P{L}*\P{L}*`)).toBeNull();
    expect(compileSafeRegexDetailed(String.raw`\p{L}*\p{Ll}*`, "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileSafeRegex(String.raw`^\p{L}*\p{N}*z$`, "u")).toBeInstanceOf(RegExp);
    expect(
      tokenizePattern(String.raw`\p{(a+)+}`).some((token) => token.kind === "group-open"),
    ).toBe(true);
    expect(compileSafeRegexDetailed(String.raw`\p{(a+)+}`).reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexForExec(String.raw`\p{(a+)+}`).regex).toBeNull();
    expect(compileSafeRegexDetailed(String.raw`\P{(a|aa)+}`).reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileSafeRegexDetailed(String.raw`\u0041*\u0041*`, "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileSafeRegexDetailed(String.raw`\x41*\x41*`, "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(
      compileSafeRegexDetailed(String.raw`\p{Script=Latin}*\p{Script=Latin}*`, "u").reason,
    ).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexDetailed(String.raw`\p{Script=Arabic}*\p{sc=Arab}*`, "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(
      compileSafeRegexForExec(String.raw`\p{Script=Arabic}*\p{sc=Arab}*`, "u").regex,
    ).toBeNull();
    expect(compileSafeRegexDetailed(String.raw`(\p{Script=Arabic}|\p{sc=Arab})+`, "u").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(
      compileSafeRegexForExec(String.raw`(\p{Script=Arabic}|\p{sc=Arab})+`, "u").regex,
    ).toBeNull();
  });

  it("rejects adjacent overlapping unbounded repeats (a*a*)", () => {
    expect(compileSafeRegex("^a*a*a*a*a*a*a*a*a*a*b$")).toBeNull();
    expect(compileSafeRegexDetailed("^a*a*a*a*a*a*a*a*a*a*b$").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileSafeRegex("a*a*")).toBeNull();
    expect(compileSafeRegex("[ab]*[ab]*")).toBeNull();
    expect(compileSafeRegex("(a)*(a)*")).toBeNull();
    expect(compileSafeRegex("(a*)(a*)")).toBeNull();
    expect(compileSafeRegex("a*(?:)a*")).toBeNull();
    expect(compileSafeRegex("[猫]*[猫]*")).toBeNull();
  });

  it("rejects adjacent unbounded groups whose complete branch unions overlap", () => {
    // Last-branch-only comparison would treat (a|b)* as "b" and (b|c)* as "c".
    expect(compileSafeRegex("^(a|b)*(b|c)*z$")).toBeNull();
    expect(compileSafeRegexDetailed("^(a|b)*(b|c)*z$").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex("^(a|b)*(b|c)*(b|d)*z$")).toBeNull();
    expect(compileSafeRegex("^(?:a|b)*(?:b|c)*z$")).toBeNull();
    expect(compileSafeRegex("^(a|(b))*(b|(c))*z$")).toBeNull();
    expect(compileSafeRegex("^(a|b)*(?:)*(b|c)*z$")).toBeNull();
    expect(compileSafeRegex("^(a|b)*(?:)?(b|c)*z$")).toBeNull();
    expect(compileSafeRegex("((a|b))*((b|c))*")).toBeNull();
    expect(compileSafeRegex("(?:(?:a|b))*(?:(?:b|c))*")).toBeNull();
    expect(compileSafeRegex("(a|b)*((b|c))*")).toBeNull();
    expect(compileSafeRegex("((a|b)*)((b|c)*)")).toBeNull();
    expect(compileSafeRegex("(a*)a*")).toBeNull();
    expect(compileSafeRegex("a*(a*)")).toBeNull();
    expect(compileSafeRegex("^(a|b)*(?=b)(b|c)*z$")).toBeNull();
    expect(compileSafeRegexForExec("^(a|b)*(b|c)*z$").regex).toBeNull();
    expect(compileSafeRegexForExec("((a|b))*((b|c))*").regex).toBeNull();
  });

  it("accepts adjacent unbounded groups whose complete branch unions are disjoint", () => {
    expect(compileSafeRegex("^(a|x)*(b|y)*z$")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("^(a|bc)*(d|ef)*z$")).toBeInstanceOf(RegExp);
    expect(compileSafeRegexDetailed("^(a|x)*(b|y)*z$").reason).toBeNull();
  });

  it("accepts adjacent repeats that do not overlap and non-adjacent twins", () => {
    expect(compileSafeRegex("a*b*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("[ab]*[cd]*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("a*xa*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("a*a")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("a{1,3}a{1,3}")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("[猫]*[犬]*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegexForExec("[猫]*[犬]*").regex).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}")).toBeInstanceOf(RegExp);
    expect(compileSafeRegexDetailed("[猫]*[犬]*").reason).toBeNull();
  });

  it("rejects overlapping unbounded repeats across a zero-minimum separator", () => {
    // `x?` / `{0,n}` / `x*` can be omitted, so a*…a* is still adjacent on that path.
    expect(compileSafeRegex("a*x?a*")).toBeNull();
    expect(compileSafeRegex("^a*x?a*x?a*x?a*b$")).toBeNull();
    expect(compileSafeRegexDetailed("^a*x?a*x?a*x?a*b$").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex("a*x{0,3}a*")).toBeNull();
    expect(compileSafeRegex("a*x{0,}a*")).toBeNull();
    expect(compileSafeRegex("a*x*a*")).toBeNull();
    expect(compileSafeRegex("a*b*a*")).toBeNull();
    expect(compileSafeRegex("a*(x)?a*")).toBeNull();
    expect(compileSafeRegex("a*(x*)a*")).toBeNull();
    expect(compileSafeRegex("a*(x?)a*")).toBeNull();
    expect(compileSafeRegex("a*(?:x)?a*")).toBeNull();
    expect(compileSafeRegex("a*[x]?a*")).toBeNull();
    expect(compileSafeRegex("a*a?a*")).toBeNull();
    expect(compileSafeRegexForExec("^a*x?a*x?a*x?a*b$").regex).toBeNull();
    expect(compileSafeRegex("a*x?b*")).toBeInstanceOf(RegExp);
    expect(compileSafeRegex("a*x+a*")).toBeInstanceOf(RegExp);
  });

  it("still compiles every default redact pattern after zero-minimum carry", () => {
    const rejected = DEFAULT_REDACT_PATTERNS.flatMap((pattern) => {
      const result = compileSafeRegexDetailed(pattern, "gi");
      return result.reason === null ? [] : [`${result.reason}: ${pattern}`];
    });
    expect(rejected).toEqual([]);
  });

  it("rejects Greek sigma case-fold ReDoS under ignore-case (Σ vs ς)", () => {
    // String#toLowerCase treats these as different; JS /i matches both.
    expect(compileSafeRegexDetailed("^(Σ|ς)+$", "i").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegex("^(Σ|ς)+$", "i")).toBeNull();
  });

  it("accepts disjoint escaped ASCII alternatives (decoded scalar escapes)", () => {
    const pattern = String.raw`^(?:\u0061|\u0062)+$`;
    const result = compileSafeRegexDetailed(pattern);
    expect(result.reason).toBeNull();
    expect(result.regex).toBeInstanceOf(RegExp);
  });

  it.each([
    [/^agent:main:discord:/, `agent:main:discord:${"x".repeat(5000)}`, true],
    [/discord:tail$/, `${"x".repeat(5000)}discord:tail`, true],
    [/discord:tail$/, `${"x".repeat(5000)}telegram:tail`, false],
  ] as const)("checks bounded regex windows for %s", (pattern, input, expected) => {
    expect(testRegexWithBoundedInput(pattern, input)).toBe(expected);
  });
});

import { describe, expect, it } from "vitest";
import { OcPathError, formatOcPath, isValidOcPath, parseOcPath } from "../oc-path.js";

describe("parseOcPath", () => {
  it("parses file-only path", () => {
    expect(parseOcPath("oc://SOUL.md")).toEqual({ file: "SOUL.md" });
  });

  it("parses file + section", () => {
    expect(parseOcPath("oc://SOUL.md/Boundaries")).toEqual({
      file: "SOUL.md",
      section: "Boundaries",
    });
  });

  it("parses file + section + item", () => {
    expect(parseOcPath("oc://SOUL.md/Boundaries/deny-rule-1")).toEqual({
      file: "SOUL.md",
      section: "Boundaries",
      item: "deny-rule-1",
    });
  });

  it("parses file + section + item + field", () => {
    expect(parseOcPath("oc://SOUL.md/Boundaries/deny-rule-1/risk")).toEqual({
      file: "SOUL.md",
      section: "Boundaries",
      item: "deny-rule-1",
      field: "risk",
    });
  });

  it("parses session query", () => {
    expect(parseOcPath("oc://SOUL.md?session=daily-cron")).toEqual({
      file: "SOUL.md",
      session: "daily-cron",
    });
  });

  it("rejects reserved chars in session query values", () => {
    expectOcPathError(
      () => parseOcPath("oc://SOUL.md?session=cron%2Fdaily"),
      "OC_PATH_RESERVED_CHAR",
    );
  });

  it("rejects control chars in session query values", () => {
    expectOcPathError(
      () => parseOcPath("oc://SOUL.md?session=daily\x00cron"),
      "OC_PATH_CONTROL_CHAR",
    );
  });

  it("rejects control chars in ignored query values", () => {
    expectOcPathError(
      () => parseOcPath("oc://SOUL.md?ignored=\x00"),
      "OC_PATH_CONTROL_CHAR",
    );
  });

  it("rejects missing scheme", () => {
    expectOcPathError(() => parseOcPath("SOUL.md"), "OC_PATH_MISSING_SCHEME");
  });

  it("rejects empty path after scheme", () => {
    expectOcPathError(() => parseOcPath("oc://"), "OC_PATH_EMPTY");
  });

  it("rejects empty segment", () => {
    expectOcPathError(() => parseOcPath("oc://SOUL.md//deny-rule-1"), "OC_PATH_EMPTY_SEGMENT");
  });

  it("rejects too-deep nesting", () => {
    expectOcPathError(() => parseOcPath("oc://SOUL.md/a/b/c/d/e"), "OC_PATH_TOO_DEEP");
  });

  it("rejects non-string input", () => {
    expectOcPathError(() => parseOcPath(123 as unknown as string), "OC_PATH_NOT_STRING");
  });
});

function expectOcPathError(fn: () => unknown, expectedCode: string): void {
  try {
    fn();
    expect.fail(`expected OcPathError with code "${expectedCode}" but no error thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(OcPathError);
    expect((err as OcPathError).code).toBe(expectedCode);
  }
}

describe("formatOcPath", () => {
  it("round-trips file-only", () => {
    expect(formatOcPath({ file: "SOUL.md" })).toBe("oc://SOUL.md");
  });

  it("round-trips full nesting", () => {
    expect(
      formatOcPath({
        file: "SOUL.md",
        section: "Boundaries",
        item: "deny-rule-1",
        field: "risk",
      }),
    ).toBe("oc://SOUL.md/Boundaries/deny-rule-1/risk");
  });

  it("round-trips session", () => {
    expect(formatOcPath({ file: "SOUL.md", session: "cron" })).toBe("oc://SOUL.md?session=cron");
  });

  it("rejects reserved chars in formatted session values", () => {
    expectOcPathError(
      () => formatOcPath({ file: "SOUL.md", session: "cron&scope=daily" }),
      "OC_PATH_RESERVED_CHAR",
    );
  });

  it("rejects empty file", () => {
    expectOcPathError(() => formatOcPath({ file: "" }), "OC_PATH_FILE_REQUIRED");
  });

  it("rejects item without section", () => {
    expectOcPathError(() => formatOcPath({ file: "F.md", item: "i" }), "OC_PATH_NESTING");
  });
});

describe("round-trip", () => {
  const cases = [
    "oc://SOUL.md",
    "oc://SOUL.md/Boundaries",
    "oc://SOUL.md/Boundaries/deny-rule-1",
    "oc://SOUL.md/Boundaries/deny-rule-1/risk",
    "oc://SOUL.md?session=daily",
    "oc://AGENTS.md/Tools/gh/risk",
  ];
  for (const input of cases) {
    it(`formatOcPath(parseOcPath("${input}")) === "${input}"`, () => {
      expect(formatOcPath(parseOcPath(input))).toBe(input);
    });
  }
});

describe("isValidOcPath", () => {
  it("returns true for valid paths", () => {
    expect(isValidOcPath("oc://SOUL.md")).toBe(true);
    expect(isValidOcPath("oc://SOUL.md/Boundaries")).toBe(true);
  });

  it("returns false for invalid paths", () => {
    expect(isValidOcPath("SOUL.md")).toBe(false);
    expect(isValidOcPath("oc://")).toBe(false);
    expect(isValidOcPath(null)).toBe(false);
    expect(isValidOcPath(undefined)).toBe(false);
    expect(isValidOcPath(42)).toBe(false);
  });
});

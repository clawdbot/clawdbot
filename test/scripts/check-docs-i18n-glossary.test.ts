import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/check-docs-i18n-glossary.mjs";

describe("check-docs-i18n-glossary", () => {
  it("parses explicit diff refs", () => {
    expect(parseArgs(["--base", "origin/main", "--head", "HEAD"])).toEqual({
      base: "origin/main",
      head: "HEAD",
    });
  });

  it("rejects missing diff ref values", () => {
    expect(() => parseArgs(["--base", "--head", "HEAD"])).toThrow("--base requires a value");
    expect(() => parseArgs(["--head"])).toThrow("--head requires a value");
    expect(() => parseArgs(["--base", ""])).toThrow("--base requires a value");
  });
});

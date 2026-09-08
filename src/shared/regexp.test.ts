import { describe, expect, it } from "vitest";
import { escapeRegExp } from "./regexp.js";

describe("escapeRegExp", () => {
  it("leaves plain text unchanged", () => {
    expect(escapeRegExp("hello world 123")).toBe("hello world 123");
  });

  it("returns an empty string for empty input", () => {
    expect(escapeRegExp("")).toBe("");
  });

  it("escapes each regex special character", () => {
    const specials = [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"];
    for (const char of specials) {
      expect(escapeRegExp(char)).toBe(`\\${char}`);
    }
  });

  it("escapes a mix of special characters within a longer string", () => {
    expect(escapeRegExp("a.b*c?[d]")).toBe("a\\.b\\*c\\?\\[d\\]");
  });

  it("produces a pattern that matches the original string literally", () => {
    const value = "1+1=2 (maybe?) [test]";
    const pattern = new RegExp(escapeRegExp(value));

    expect(pattern.test(value)).toBe(true);
    expect(pattern.test("1+1=3")).toBe(false);
  });
});

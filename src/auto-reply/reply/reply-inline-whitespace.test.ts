// Tests inline reply directive handling without corrupting surrounding whitespace.
import { describe, expect, it } from "vitest";
import { collapseInlineHorizontalWhitespace } from "./reply-inline-whitespace.js";

describe("collapseInlineHorizontalWhitespace", () => {
  it("collapses spaces and tabs but preserves newlines", () => {
    const value = "hello\t\tworld\n  next\tline";
    expect(collapseInlineHorizontalWhitespace(value)).toBe("hello world\n next line");
  });
});

// Tests for attributed block tag normalization in plain-text sanitization
import { describe, expect, it } from "vitest";
import { sanitizeForPlainText } from "./sanitize-text.js";

describe("sanitizeForPlainText attributed block tags", () => {
  it.each([
    'before<p class="lead">inside</p>after',
    'before<div data-layout="section">inside</div>after',
    'before<p id="para" class="text">inside</p>after',
    'before<div style="color:red;">inside</div>after',
  ])("preserves block boundaries for %s", (input) => {
    expect(sanitizeForPlainText(input)).toBe(
      "before\ninside\nafter",
    );
  });

  it("handles multiple attributed block tags", () => {
    expect(
      sanitizeForPlainText('before<p>first</p><div>second</div>after')
    ).toBe("before\nfirst\n\nsecond\nafter");
  });

  it("preserves bare block tag behavior", () => {
    expect(sanitizeForPlainText("<p>paragraph</p>")).toBe("\nparagraph\n");
    expect(sanitizeForPlainText("<div>content</div>")).toBe("\ncontent\n");
  });

  it("works with markdown style option", () => {
    // In markdown style, bold/italic/etc use different markers
    expect(sanitizeForPlainText('before<p class="lead"><b>bold</b></p>after', { style: "markdown" }))
      .toBe("before\n**bold**\nafter");
  });
});
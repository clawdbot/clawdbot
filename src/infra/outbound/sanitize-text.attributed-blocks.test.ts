import { describe, expect, it } from "vitest";
import { sanitizeForPlainText } from "./sanitize-text.js";

describe("sanitizeForPlainText attributed block tags", () => {
  it.each([
    'before<p class="lead">inside</p>after',
    'before<div data-layout="section">inside</div>after',
  ])("preserves block boundaries for %s", (input) => {
    expect(sanitizeForPlainText(input)).toBe("before\ninside\nafter");
  });
});

import { describe, expect, it } from "vitest";
import { escapeHtml } from "./text-utility-runtime.js";

describe("escapeHtml", () => {
  it("escapes five HTML-sensitive characters and existing entity markers", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml("already &amp; escaped")).toBe("already &amp;amp; escaped");
  });
});

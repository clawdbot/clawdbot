import { describe, expect, it } from "vitest";
import { formatVoiceLogPreview } from "./log-preview.js";

describe("formatVoiceLogPreview", () => {
  it("collapses whitespace and trims the preview", () => {
    expect(formatVoiceLogPreview("  hello \n world\t")).toBe("hello world");
  });

  it("truncates long previews after 500 characters", () => {
    const preview = formatVoiceLogPreview("x".repeat(501));
    expect(preview).toBe(`${"x".repeat(500)}...`);
  });

  it("does not split emoji when the preview limit lands inside a surrogate pair", () => {
    const preview = formatVoiceLogPreview(`${"x".repeat(499)}😀tail`);
    expect(preview).toBe(`${"x".repeat(499)}...`);
    expect(preview).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});

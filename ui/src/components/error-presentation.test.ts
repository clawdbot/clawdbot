import { describe, expect, it } from "vitest";
import { formatWebUiIconErrorText, normalizeErrorComparisonText } from "./error-presentation.ts";

describe("error-presentation", () => {
  describe("normalizeErrorComparisonText", () => {
    it("strips multi-glyph icon prefixes", () => {
      expect(normalizeErrorComparisonText("⚠️ hello")).toBe("hello");
      expect(normalizeErrorComparisonText("⚠️⚠️ hello")).toBe("hello");
      expect(normalizeErrorComparisonText("⚠️ ⚠️ hello")).toBe("hello");
      expect(normalizeErrorComparisonText("⚠️  ⚠️  hello")).toBe("hello");
    });

    it("strips variation-selector prefixes", () => {
      expect(normalizeErrorComparisonText("⚠️\uFE0F hello")).toBe("hello");
      expect(normalizeErrorComparisonText("⚠️\uFE0F ⚠️ hello")).toBe("hello");
      expect(normalizeErrorComparisonText("\u26A0 hello")).toBe("hello");
      expect(normalizeErrorComparisonText("\u26A0\uFE0F hello")).toBe("hello");
      expect(normalizeErrorComparisonText("⚠️\uFE0F⚠️ hello")).toBe("hello");
    });

    it("strips repeated Error: prefixes", () => {
      expect(normalizeErrorComparisonText("Error: foo")).toBe("foo");
      expect(normalizeErrorComparisonText("Error: Error: foo")).toBe("foo");
      expect(normalizeErrorComparisonText("Error: error: foo")).toBe("foo");
      expect(normalizeErrorComparisonText("error: ERROR: foo")).toBe("foo");
    });

    it("strips interleaved repeated icon and Error: prefixes", () => {
      expect(normalizeErrorComparisonText("⚠️ Error: foo")).toBe("foo");
      expect(normalizeErrorComparisonText("Error: ⚠️ foo")).toBe("foo");
      expect(normalizeErrorComparisonText("⚠️ Error: ⚠️ Error: foo")).toBe("foo");
      expect(normalizeErrorComparisonText("⚠️⚠️ Error: Error: foo")).toBe("foo");
      expect(normalizeErrorComparisonText("Error: ⚠️ Error: ⚠️ foo")).toBe("foo");
      expect(normalizeErrorComparisonText("⚠️\uFE0F Error: foo")).toBe("foo");
      expect(normalizeErrorComparisonText("Error: ⚠️\uFE0F foo")).toBe("foo");
    });

    it("collapses whitespace and trims", () => {
      expect(normalizeErrorComparisonText("Error:   foo   bar  ")).toBe("foo bar");
      expect(normalizeErrorComparisonText("⚠️   foo\t\nbar")).toBe("foo bar");
      expect(normalizeErrorComparisonText("  ⚠️  Error:  foo   bar  ")).toBe("foo bar");
      expect(normalizeErrorComparisonText("foo   bar")).toBe("foo bar");
    });

    it("preserves body emoji", () => {
      expect(normalizeErrorComparisonText("⚠️ hello ⚠️ world")).toBe("hello ⚠️ world");
      expect(normalizeErrorComparisonText("Error: foo ⚠️ bar")).toBe("foo ⚠️ bar");
      expect(normalizeErrorComparisonText("⚠️ Error: foo ⚠️ bar")).toBe("foo ⚠️ bar");
      expect(normalizeErrorComparisonText("hello ⚠️ world")).toBe("hello ⚠️ world");
      expect(normalizeErrorComparisonText("⚠️\uFE0F hello ⚠️ world")).toBe("hello ⚠️ world");
    });

    it("preserves Error: prefix and whitespace collapse semantics", () => {
      expect(normalizeErrorComparisonText("Error: foo bar")).toBe("foo bar");
      expect(normalizeErrorComparisonText("  foo   bar  ")).toBe("foo bar");
    });
  });

  describe("formatWebUiIconErrorText", () => {
    it("preserves plain text", () => {
      expect(formatWebUiIconErrorText("hello")).toBe("hello");
    });

    it("removes leading presentation glyphs only", () => {
      expect(formatWebUiIconErrorText("⚠️ hello")).toBe(" hello");
      expect(formatWebUiIconErrorText("⚠️⚠️ hello")).toBe(" hello");
      expect(formatWebUiIconErrorText("⚠️\uFE0F hello")).toBe(" hello");
      expect(formatWebUiIconErrorText("⚠️ ⚠️ hello")).toBe("  hello");
      expect(formatWebUiIconErrorText("⛔ 🛠️ Failure")).toBe("  Failure");
    });

    it("preserves leading Error text prefixes", () => {
      expect(formatWebUiIconErrorText("Error: hello")).toBe("Error: hello");
      expect(formatWebUiIconErrorText("Error: Error: hello")).toBe("Error: Error: hello");
    });

    it("preserves body emoji", () => {
      expect(formatWebUiIconErrorText("hello ⚠️ world")).toBe("hello ⚠️ world");
      expect(formatWebUiIconErrorText("⚠️ hello ⚠️ world")).toBe(" hello ⚠️ world");
    });
  });
});

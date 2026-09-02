import { describe, expect, it } from "vitest";
import {
  formatWebUiIconErrorText,
  normalizeErrorComparisonText,
  stripErrorIconPrefix,
} from "./error-presentation.ts";

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
    });

    it("strips repeated Error: prefixes", () => {
      expect(normalizeErrorComparisonText("Error: foo")).toBe("foo");
      expect(normalizeErrorComparisonText("Error: Error: foo")).toBe("foo");
      expect(normalizeErrorComparisonText("error: ERROR: foo")).toBe("foo");
    });

    it("strips interleaved repeated icon and Error: prefixes", () => {
      expect(normalizeErrorComparisonText("⚠️ Error: foo")).toBe("foo");
      expect(normalizeErrorComparisonText("Error: ⚠️ foo")).toBe("foo");
      expect(normalizeErrorComparisonText("⚠️ Error: ⚠️ Error: foo")).toBe("foo");
      expect(normalizeErrorComparisonText("⚠️⚠️ Error: Error: foo")).toBe("foo");
      expect(normalizeErrorComparisonText("⚠️\uFE0F Error: foo")).toBe("foo");
    });

    it("collapses whitespace and trims", () => {
      expect(normalizeErrorComparisonText("Error:   foo   bar  ")).toBe("foo bar");
      expect(normalizeErrorComparisonText("⚠️   foo\t\nbar")).toBe("foo bar");
      expect(normalizeErrorComparisonText("  ⚠️  Error:  foo   bar  ")).toBe("foo bar");
    });

    it("preserves body emoji", () => {
      expect(normalizeErrorComparisonText("⚠️ hello ⚠️ world")).toBe("hello ⚠️ world");
      expect(normalizeErrorComparisonText("Error: foo ⚠️ bar")).toBe("foo ⚠️ bar");
    });
  });

  describe("formatWebUiIconErrorText", () => {
    it("prefixes plain text with icon", () => {
      expect(formatWebUiIconErrorText("hello")).toBe("⚠️ hello");
    });

    it("normalizes leading icon prefixes to single token", () => {
      expect(formatWebUiIconErrorText("⚠️ hello")).toBe("⚠️ hello");
      expect(formatWebUiIconErrorText("⚠️⚠️ hello")).toBe("⚠️ hello");
      expect(formatWebUiIconErrorText("⚠️\uFE0F hello")).toBe("⚠️ hello");
    });

    it("returns single icon for empty input", () => {
      expect(formatWebUiIconErrorText("")).toBe("⚠️");
      expect(formatWebUiIconErrorText("   ")).toBe("⚠️");
    });

    it("preserves body emoji", () => {
      expect(formatWebUiIconErrorText("hello ⚠️ world")).toBe("⚠️ hello ⚠️ world");
    });
  });

  describe("stripErrorIconPrefix", () => {
    it("removes leading icon prefix only", () => {
      expect(stripErrorIconPrefix("⚠️ hello")).toBe("hello");
      expect(stripErrorIconPrefix("hello ⚠️ world")).toBe("hello ⚠️ world");
      expect(stripErrorIconPrefix("⚠️⚠️ hello")).toBe("hello");
    });
  });
});

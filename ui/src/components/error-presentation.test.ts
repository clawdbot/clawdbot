import { describe, expect, it } from "vitest";
import {
  ERROR_ICON_PREFIX_RE,
  ERROR_ICON_TOKEN,
  ERROR_TEXT_PREFIX_RE,
  formatWebUiIconErrorText,
  normalizeErrorComparisonText,
} from "./error-presentation.ts";

describe("error-presentation", () => {
  describe("ERROR_ICON_PREFIX_RE", () => {
    it("matches a single glyph prefix", () => {
      expect("⚠️ hello".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello");
    });

    it("matches multi-glyph repeated icon prefixes", () => {
      expect("⚠️⚠️ hello".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello");
      expect("⚠️ ⚠️ hello".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello");
      expect("⚠️  ⚠️  hello".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello");
      expect("⚠️⚠️⚠️ hello".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello");
    });

    it("matches variation-selector prefixes", () => {
      expect("⚠️\uFE0F hello".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello");
      expect("⚠️\uFE0F ⚠️ hello".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello");
      expect("\u26A0 hello".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello");
      expect("\u26A0\uFE0F hello".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello");
      expect("\u26A0\uFE0F\uFE0F hello".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello");
    });

    it("preserves body emoji", () => {
      expect("⚠️ hello ⚠️ world".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello ⚠️ world");
      expect("⚠️ hello \u26A0 world".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello \u26A0 world");
      expect("hello ⚠️ world".replace(ERROR_ICON_PREFIX_RE, "")).toBe("hello ⚠️ world");
    });
  });

  describe("ERROR_TEXT_PREFIX_RE", () => {
    it("matches a single Error: prefix case-insensitively", () => {
      expect("Error: foo".replace(ERROR_TEXT_PREFIX_RE, "")).toBe("foo");
      expect("error: foo".replace(ERROR_TEXT_PREFIX_RE, "")).toBe("foo");
      expect("ERROR: foo".replace(ERROR_TEXT_PREFIX_RE, "")).toBe("foo");
    });

    it("matches repeated Error: prefixes", () => {
      expect("Error: Error: foo".replace(ERROR_TEXT_PREFIX_RE, "")).toBe("foo");
      expect("Error: error: Error: foo".replace(ERROR_TEXT_PREFIX_RE, "")).toBe("foo");
      expect("Error:  Error:   foo".replace(ERROR_TEXT_PREFIX_RE, "")).toBe("foo");
    });
  });

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
    it("prefixes plain text with the icon token", () => {
      expect(formatWebUiIconErrorText("hello")).toBe(`${ERROR_ICON_TOKEN} hello`);
    });

    it("normalizes already-prefixed text to a single token", () => {
      expect(formatWebUiIconErrorText("⚠️ hello")).toBe(`${ERROR_ICON_TOKEN} hello`);
      expect(formatWebUiIconErrorText("⚠️⚠️ hello")).toBe(`${ERROR_ICON_TOKEN} hello`);
      expect(formatWebUiIconErrorText("⚠️\uFE0F hello")).toBe(`${ERROR_ICON_TOKEN} hello`);
      expect(formatWebUiIconErrorText("⚠️ ⚠️ hello")).toBe(`${ERROR_ICON_TOKEN} hello`);
    });

    it("normalizes Error: prefixed text to icon prefix", () => {
      expect(formatWebUiIconErrorText("Error: hello")).toBe(`${ERROR_ICON_TOKEN} hello`);
      expect(formatWebUiIconErrorText("Error: Error: hello")).toBe(`${ERROR_ICON_TOKEN} hello`);
    });

    it("preserves body emoji", () => {
      expect(formatWebUiIconErrorText("hello ⚠️ world")).toBe(`${ERROR_ICON_TOKEN} hello ⚠️ world`);
      expect(formatWebUiIconErrorText("⚠️ hello ⚠️ world")).toBe(`${ERROR_ICON_TOKEN} hello ⚠️ world`);
    });
  });
});

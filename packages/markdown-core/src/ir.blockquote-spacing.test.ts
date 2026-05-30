/**
 * Blockquote Spacing Tests
 *
 * Per CommonMark spec (§5.1 Block quotes), blockquotes are "container blocks" that
 * contain other block-level elements (paragraphs, code blocks, etc.).
 *
 * In plaintext rendering, the expected spacing between block-level elements is
 * a single blank line (double newline `\n\n`). This is the standard paragraph
 * separation used throughout markdown.
 *
 * CORRECT behavior:
 *   - Blockquote content followed by paragraph: "quote\n\nparagraph" (double \n)
 *   - Two consecutive blockquotes: "first\n\nsecond" (double \n)
 *
 * BUG (current behavior):
 *   - Produces triple newlines: "quote\n\n\nparagraph"
 *
 * Root cause:
 *   1. `paragraph_close` inside blockquote adds `\n\n` (correct)
 *   2. `blockquote_close` adds another `\n` (incorrect)
 *   3. Result: `\n\n\n` (triple newlines - incorrect)
 *
 * The fix: `blockquote_close` should NOT add `\n` because:
 *   - Blockquotes are container blocks, not leaf blocks
 *   - The inner content (paragraph, heading, etc.) already provides block separation
 *   - Container closings shouldn't add their own spacing
 */

import { describe, it, expect } from "vitest";
import { markdownToIR } from "./ir.js";

describe("blockquote spacing", () => {
  describe("blockquote followed by paragraph", () => {
    it("should have double newline (one blank line) between blockquote and paragraph", () => {
      const input = "> quote\n\nparagraph";
      const result = markdownToIR(input);

      // CORRECT: "quote\n\nparagraph" (double newline)
      // BUG: "quote\n\n\nparagraph" (triple newline)
      expect(result.text).toBe("quote\n\nparagraph");
    });

    it("should not produce triple newlines", () => {
      const input = "> quote\n\nparagraph";
      const result = markdownToIR(input);

      expect(result.text).not.toContain("\n\n\n");
    });

    it("excludes the trailing paragraph separator from the blockquote span", () => {
      const result = markdownToIR("> `gpt`\n\nbody");

      expect(result).toEqual({
        text: "gpt\n\nbody",
        styles: [
          { start: 0, end: 3, style: "blockquote" },
          { start: 0, end: 3, style: "code" },
        ],
        links: [],
      });
    });
  });

  describe("consecutive blockquotes", () => {
    it("should have double newline between two blockquotes", () => {
      const input = "> first\n\n> second";
      const result = markdownToIR(input);

      expect(result.text).toBe("first\n\nsecond");
    });

    it("should not produce triple newlines between blockquotes", () => {
      const input = "> first\n\n> second";
      const result = markdownToIR(input);

      expect(result.text).not.toContain("\n\n\n");
    });
  });

  describe("nested blockquotes", () => {
    it("should handle nested blockquotes correctly", () => {
      const input = "> outer\n>> inner";
      const result = markdownToIR(input);

      // Inner blockquote becomes separate paragraph
      expect(result.text).toBe("outer\n\ninner");
    });

    it("should not produce triple newlines in nested blockquotes", () => {
      const input = "> outer\n>> inner\n\nparagraph";
      const result = markdownToIR(input);

      expect(result.text).not.toContain("\n\n\n");
    });

    it("should handle deeply nested blockquotes", () => {
      const input = "> level 1\n>> level 2\n>>> level 3";
      const result = markdownToIR(input);

      // Each nested level is a new paragraph
      expect(result.text).toBe("level 1\n\nlevel 2\n\nlevel 3");
    });
  });

  describe("blockquote followed by other block elements", () => {
    it("should have double newline between blockquote and heading", () => {
      const input = "> quote\n\n# Heading";
      const result = markdownToIR(input);

      expect(result.text).toBe("quote\n\nHeading");
      expect(result.text).not.toContain("\n\n\n");
    });

    it("should have double newline between blockquote and list", () => {
      const input = "> quote\n\n- item";
      const result = markdownToIR(input);

      // The list item becomes "• item"
      expect(result.text).toBe("quote\n\n• item");
      expect(result.text).not.toContain("\n\n\n");
    });

    it("should have double newline between blockquote and code block", () => {
      const input = "> quote\n\n```\ncode\n```";
      const result = markdownToIR(input);

      // Code blocks preserve their trailing newline
      expect(result.text).toBe("quote\n\ncode\n");
    });

    it("should have double newline between blockquote and horizontal rule", () => {
      const input = "> quote\n\n---\n\nparagraph";
      const result = markdownToIR(input);

      expect(result.text).toBe("quote\n\n───\n\nparagraph");
    });
  });

  describe("blockquote with multi-paragraph content", () => {
    it("should handle multi-paragraph blockquote followed by paragraph", () => {
      const input = "> first paragraph\n>\n> second paragraph\n\nfollowing paragraph";
      const result = markdownToIR(input);

      // Multi-paragraph blockquote should have proper internal spacing
      // AND proper spacing with following content
      expect(result.text).toBe("first paragraph\n\nsecond paragraph\n\nfollowing paragraph");
    });
  });

  describe("blockquote prefix option", () => {
    it("should include prefix and maintain proper spacing", () => {
      const input = "> quote\n\nparagraph";
      const result = markdownToIR(input, { blockquotePrefix: "> " });

      // With prefix, should still have proper spacing
      expect(result.text).toBe("> quote\n\nparagraph");
      expect(result.text).not.toContain("\n\n\n");
    });
  });

  describe("edge cases", () => {
    it("should handle empty blockquote followed by paragraph", () => {
      const input = ">\n\nparagraph";
      const result = markdownToIR(input);

      expect(result.text).toBe("paragraph");
    });

    it("should handle blockquote at end of document", () => {
      const input = "paragraph\n\n> quote";
      const result = markdownToIR(input);

      expect(result.text).toBe("paragraph\n\nquote");
    });

    it("should handle multiple blockquotes with paragraphs between", () => {
      const input = "> first\n\nparagraph\n\n> second";
      const result = markdownToIR(input);

      expect(result.text).toBe("first\n\nparagraph\n\nsecond");
      expect(result.text).not.toContain("\n\n\n");
    });
  });
});

describe("comparison with other block elements (control group)", () => {
  it("paragraphs should have double newline separation", () => {
    const input = "paragraph 1\n\nparagraph 2";
    const result = markdownToIR(input);

    expect(result.text).toBe("paragraph 1\n\nparagraph 2");
    expect(result.text).not.toContain("\n\n\n");
  });

  it("list followed by paragraph should have double newline", () => {
    const input = "- item 1\n- item 2\n\nparagraph";
    const result = markdownToIR(input);

    // Lists already work correctly
    expect(result.text).toBe("• item 1\n• item 2\n\nparagraph");
  });

  it("heading followed by paragraph should have double newline", () => {
    const input = "# Heading\n\nparagraph";
    const result = markdownToIR(input);

    expect(result.text).toBe("Heading\n\nparagraph");
    expect(result.text).not.toContain("\n\n\n");
  });
});

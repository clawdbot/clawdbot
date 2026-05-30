import { describe, it, expect } from "vitest";
import { markdownToIR } from "./ir.js";

/**
 * HR (Thematic Break) Spacing Analysis
 * =====================================
 *
 * CommonMark Spec (0.31.2) Section 4.1 - Thematic Breaks:
 * - Thematic breaks (---, ***, ___) produce <hr /> in HTML
 * - "Thematic breaks do not need blank lines before or after"
 * - A thematic break can interrupt a paragraph
 *
 * HTML Output per spec:
 *   Input: "Foo\n***\nbar"
 *   HTML:  "<p>Foo</p>\n<hr />\n<p>bar</p>"
 *
 * PLAIN TEXT OUTPUT DECISION:
 *
 * The HR element is a block-level thematic separator. In plain text output,
 * we render HRs as a visible separator "───" to maintain visual distinction.
 */

describe("hr (thematic break) spacing", () => {
  describe("current behavior documentation", () => {
    it("just hr alone renders as separator", () => {
      const result = markdownToIR("---");
      expect(result.text).toBe("───");
    });

    it("hr interrupting paragraph (setext heading case)", () => {
      // Note: "Para\n---" is a setext heading in CommonMark!
      // Using *** to test actual HR behavior
      const input = `Para 1
***
Para 2`;
      const result = markdownToIR(input);
      // HR interrupts para, renders visibly
      expect(result.text).toContain("───");
    });
  });

  describe("expected behavior (tests assert CORRECT behavior)", () => {
    it("hr between paragraphs should render with separator", () => {
      const input = `Para 1

---

Para 2`;
      const result = markdownToIR(input);
      expect(result.text).toBe("Para 1\n\n───\n\nPara 2");
    });

    it("hr between paragraphs using *** should render with separator", () => {
      const input = `Para 1

***

Para 2`;
      const result = markdownToIR(input);
      expect(result.text).toBe("Para 1\n\n───\n\nPara 2");
    });

    it("hr between paragraphs using ___ should render with separator", () => {
      const input = `Para 1

___

Para 2`;
      const result = markdownToIR(input);
      expect(result.text).toBe("Para 1\n\n───\n\nPara 2");
    });

    it("consecutive hrs should produce multiple separators", () => {
      const input = `---
---
---`;
      const result = markdownToIR(input);
      // Each HR renders as a separator
      expect(result.text).toBe("───\n\n───\n\n───");
    });

    it("hr at document end renders separator", () => {
      const input = `Para

---`;
      const result = markdownToIR(input);
      expect(result.text).toBe("Para\n\n───");
    });

    it("hr at document start renders separator", () => {
      const input = `---

Para`;
      const result = markdownToIR(input);
      expect(result.text).toBe("───\n\nPara");
    });

    it("should not produce triple newlines regardless of hr placement", () => {
      const inputs = [
        "Para 1\n\n---\n\nPara 2",
        "Para 1\n---\nPara 2",
        "---\nPara",
        "Para\n---",
        "Para 1\n\n---\n\n---\n\nPara 2",
        "Para 1\n\n***\n\n---\n\n___\n\nPara 2",
      ];

      for (const input of inputs) {
        const result = markdownToIR(input);
        expect(result.text, `Input: ${JSON.stringify(input)}`).not.toMatch(/\n{3,}/);
      }
    });

    it("multiple consecutive hrs between paragraphs should each render as separator", () => {
      const input = `Para 1

---

---

---

Para 2`;
      const result = markdownToIR(input);
      expect(result.text).toBe("Para 1\n\n───\n\n───\n\n───\n\nPara 2");
    });
  });

  describe("edge cases", () => {
    it("hr between list items renders as separator without extra spacing", () => {
      const input = `- Item 1
- ---
- Item 2`;
      const result = markdownToIR(input);
      expect(result.text).toBe("• Item 1\n\n───\n\n• Item 2");
      expect(result.text).not.toMatch(/\n{3,}/);
    });

    it("hr followed immediately by heading", () => {
      const input = `---

# Heading

Para`;
      const result = markdownToIR(input);
      // HR renders as separator, heading renders, para follows
      expect(result.text).not.toMatch(/\n{3,}/);
      expect(result.text).toContain("───");
    });

    it("heading followed by hr", () => {
      const input = `# Heading

---

Para`;
      const result = markdownToIR(input);
      // Heading ends, HR renders, para follows
      expect(result.text).not.toMatch(/\n{3,}/);
      expect(result.text).toContain("───");
    });
  });
});

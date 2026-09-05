import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "./internal.js";
import { estimateStringChars } from "./openclaw-runtime-io.js";

describe("weighted memory chunk budgets", () => {
  it.each([
    { label: "long ASCII", text: "a".repeat(3000), tokens: 400, budget: 1600 },
    { label: "rare BMP ideographs", text: "\u3400".repeat(200), tokens: 400, budget: 1600 },
    { label: "supplementary ideographs", text: "\u{20000}".repeat(150), tokens: 400, budget: 1600 },
    { label: "odd UTF-16 split positions", text: "\u{20000}".repeat(120), tokens: 31, budget: 124 },
  ])("bounds $label without losing text or source positions", ({ text, tokens, budget }) => {
    const chunks = chunkMarkdown(text, { tokens, overlap: 0 });

    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(estimateStringChars(chunk.text)).toBeLessThanOrEqual(budget);
      expect(() => encodeURIComponent(chunk.text)).not.toThrow();
      expect(chunk.startLine).toBe(1);
      expect(chunk.endLine).toBe(1);
    }
  });
});

// Markdown Core tests cover ir.chunking behavior.
import { describe, expect, it } from "vitest";
import { chunkMarkdownIR, type MarkdownIR } from "./ir.js";

describe("chunkMarkdownIR", () => {
  it("keeps the final in-limit remainder together after a soft break", () => {
    const ir: MarkdownIR = {
      text: "abcdefgh ij kl",
      styles: [],
      links: [],
    };

    expect(chunkMarkdownIR(ir, 10).map((chunk) => chunk.text)).toEqual(["abcdefgh", "ij kl"]);
  });
});

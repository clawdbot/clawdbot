// Markdown Core tests cover render aware chunking behavior.
import { describe, expect, it } from "vitest";
import type { MarkdownIR } from "./ir.js";
import { markdownToIR } from "./ir.js";
import { renderMarkdownIRChunksWithinLimit } from "./render-aware-chunking.js";
import { renderMarkdownWithMarkers } from "./render.js";

function renderEscapedHtml(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "<b>", close: "</b>" },
      italic: { open: "<i>", close: "</i>" },
      strikethrough: { open: "<s>", close: "</s>" },
      code: { open: "<code>", close: "</code>" },
      code_block: { open: "<pre><code>", close: "</code></pre>" },
      spoiler: { open: "<tg-spoiler>", close: "</tg-spoiler>" },
      blockquote: { open: "<blockquote>", close: "</blockquote>" },
    },
    escapeText: (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  });
}

describe("renderMarkdownIRChunksWithinLimit", () => {
  it("prefers word boundaries when escaping shrinks the render budget", () => {
    const ir = markdownToIR("alpha <<");
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir,
      limit: 8,
      renderChunk: renderEscapedHtml,
      measureRendered: (rendered) => rendered.length,
    });

    expect(chunks.map((chunk) => chunk.source.text)).toEqual(["alpha ", "<<"]);
    expect(chunks.map((chunk) => chunk.source.text).join("")).toBe("alpha <<");
    expect(chunks.every((chunk) => chunk.rendered.length <= 8)).toBe(true);
  });

  it("preserves formatting when a rendered chunk is re-split", () => {
    const ir = markdownToIR("**Which of these**", {
      headingStyle: "none",
    });
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir,
      limit: 16,
      renderChunk: renderEscapedHtml,
      measureRendered: (rendered) => rendered.length,
    });

    expect(chunks.map((chunk) => chunk.source.text)).toEqual(["Which of ", "these"]);
    expect(chunks.every((chunk) => chunk.rendered.startsWith("<b>"))).toBe(true);
    expect(chunks.every((chunk) => chunk.rendered.endsWith("</b>"))).toBe(true);
  });

  it("checks exact candidates instead of assuming rendered length is monotonic", () => {
    const ir: MarkdownIR = {
      text: "README.md<",
      styles: [],
      links: [],
    };
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir,
      limit: 10,
      renderChunk: (chunk) =>
        chunk.text === "README.md"
          ? "fits-here"
          : chunk.text.startsWith("README.md")
            ? "this-rendering-is-too-long"
            : chunk.text,
      measureRendered: (rendered) => rendered.length,
    });

    expect(chunks.map((chunk) => chunk.source.text)).toEqual(["README.md", "<"]);
  });

  it("preserves separator whitespace in the initial rendered-size split", () => {
    const ir = markdownToIR("alpha beta gamma");
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir,
      limit: 10,
      renderChunk: (chunk) => chunk.text,
      measureRendered: (rendered) => rendered.length,
    });

    expect(chunks.map((chunk) => chunk.source.text)).toEqual(["alpha ", "beta gamma"]);
    expect(chunks.map((chunk) => chunk.source.text).join("")).toBe(ir.text);
  });

  it("normalizes non-finite limits before chunking", () => {
    const ir = markdownToIR("abc");
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir,
      limit: Number.NaN,
      renderChunk: renderEscapedHtml,
      measureRendered: (rendered) => rendered.length,
    });

    expect(chunks.map((chunk) => chunk.source.text)).toEqual(["a", "b", "c"]);
    expect(chunks.every((chunk) => chunk.rendered.length <= 1)).toBe(true);
  });

  it("keeps astral characters whole when a positive limit reaches their pair", () => {
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir: markdownToIR("A😀B"),
      limit: 1,
      renderChunk: (chunk) => chunk.text,
      measureRendered: (rendered) => rendered.length,
    });

    expect(chunks.map((chunk) => chunk.source.text)).toEqual(["A", "😀", "B"]);
  });

  it("keeps astral characters whole when rendered size requires a retry split", () => {
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir: markdownToIR("A😀"),
      limit: 3,
      renderChunk: (chunk) => (chunk.text === "A😀" ? "too long" : chunk.text),
      measureRendered: (rendered) => rendered.length,
    });

    expect(chunks.map((chunk) => chunk.source.text)).toEqual(["A", "😀"]);
  });

  it("keeps split order while processing the worklist as a stack", () => {
    const text = "abcdefghijklmnopqrstuvwx";
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir: markdownToIR(text),
      limit: 5,
      renderChunk: (chunk) => chunk.text,
      measureRendered: (rendered) => rendered.length,
    });

    expect(chunks.map((chunk) => chunk.source.text).join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.rendered.length <= 5)).toBe(true);
  });

  it("treats Infinity as no size cap and returns a single chunk", () => {
    const text = "one two three four five six seven eight nine ten";
    const ir = markdownToIR(text);
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir,
      limit: Number.POSITIVE_INFINITY,
      renderChunk: renderEscapedHtml,
      measureRendered: (rendered) => rendered.length,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.source.text).toBe(text);
  });
});

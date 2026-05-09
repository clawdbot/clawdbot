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
});

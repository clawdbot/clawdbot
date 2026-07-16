import { describe, expect, it } from "vitest";
import { markdownToIR, sliceMarkdownIR } from "./ir.js";
import { renderMarkdownWithMarkers } from "./render.js";

describe("renderMarkdownWithMarkers semantic annotations", () => {
  it("renders transcript annotations while suppressing nested marker syntax", () => {
    const ir = markdownToIR("**user[Thu 2026-07-02] continue**", {
      assistantTranscriptRoleHeaders: true,
    });

    expect(
      renderMarkdownWithMarkers(ir, {
        annotationMarkers: {
          assistant_transcript_role: {
            open: "`",
            close: "`",
            suppressNestedFormatting: true,
          },
        },
        styleMarkers: { bold: { open: "*", close: "*" } },
        escapeText: (text) => text,
      }),
    ).toBe("`user[Thu 2026-07-02]`* continue*");
  });

  it("keeps annotations when an IR slice starts inside the marked header", () => {
    const ir = markdownToIR("user[Thu 2026-07-02] continue", {
      assistantTranscriptRoleHeaders: true,
    });
    const sliced = sliceMarkdownIR(ir, 4, ir.text.length);

    expect(sliced.annotations).toEqual([
      expect.objectContaining({ start: 0, end: "[Thu 2026-07-02]".length }),
    ]);
  });

  it("closes and reopens formatting that crosses an annotation boundary", () => {
    const ir = markdownToIR("user[**Thu] trailing**", {
      assistantTranscriptRoleHeaders: true,
    });

    expect(
      renderMarkdownWithMarkers(ir, {
        annotationMarkers: {
          assistant_transcript_role: { open: "`", close: "`" },
        },
        styleMarkers: { bold: { open: "*", close: "*" } },
        escapeText: (text) => text,
      }),
    ).toBe("`user[*Thu]*`* trailing*");
  });

  it("keeps structural containers outside dominant annotations", () => {
    const ir = markdownToIR("> user[Thu 2026-07-02] continue", {
      assistantTranscriptRoleHeaders: true,
    });

    expect(
      renderMarkdownWithMarkers(ir, {
        annotationMarkers: {
          assistant_transcript_role: {
            open: "<code>",
            close: "</code>",
            suppressNestedFormatting: true,
          },
        },
        styleMarkers: { blockquote: { open: "<blockquote>", close: "</blockquote>" } },
        escapeText: (text) => text,
      }),
    ).toBe("<blockquote><code>user[Thu 2026-07-02]</code> continue</blockquote>");
  });

  it("renders many independently styled annotations without cross-product scans", () => {
    const markdown = Array.from(
      { length: 256 },
      (_, index) => `**user[t${index}]** line ${index}`,
    ).join("\n");
    const ir = markdownToIR(markdown, { assistantTranscriptRoleHeaders: true });
    const rendered = renderMarkdownWithMarkers(ir, {
      annotationMarkers: {
        assistant_transcript_role: {
          open: "`",
          close: "`",
          suppressNestedFormatting: true,
        },
      },
      styleMarkers: { bold: { open: "*", close: "*" } },
      escapeText: (text) => text,
    });

    expect(rendered.match(/`user\[t\d+\]`/gu)).toHaveLength(256);
  });
});

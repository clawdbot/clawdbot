import { describe, expect, it } from "vitest";
import { markdownToIR, sliceMarkdownIR } from "./ir.js";
import { renderMarkdownWithAttributedRanges } from "./render-attributed.js";
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

describe("renderMarkdownWithAttributedRanges", () => {
  it("projects annotations and splits styles around link suffixes", () => {
    const ir = markdownToIR("user[Thu] **[docs](https://example.com) tail**", {
      assistantTranscriptRoleHeaders: true,
    });
    expect(
      renderMarkdownWithAttributedRanges(ir, {
        styleMap: { bold: "strong" },
        annotationStyleMap: { assistant_transcript_role: "code" },
        renderLink: (link) => ` (${link.href})`,
      }),
    ).toEqual({
      text: "user[Thu] docs (https://example.com) tail",
      ranges: [
        { start: 0, length: 9, style: "code" },
        { start: 10, length: 4, style: "strong" },
        { start: 36, length: 5, style: "strong" },
      ],
    });
  });

  it("uses UTF-16 offsets and clamps ranges after trimming", () => {
    expect(
      renderMarkdownWithAttributedRanges(
        {
          text: "😀 CJK文字  ",
          styles: [{ start: 3, end: 10, style: "bold" }],
          links: [],
        },
        { styleMap: { bold: "strong" }, trimEnd: true },
      ),
    ).toEqual({
      text: "😀 CJK文字",
      ranges: [{ start: 3, length: 5, style: "strong" }],
    });
  });
});

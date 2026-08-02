import { describe, expect, it } from "vitest";
import type { FormatCapabilityProfile } from "./format-capabilities.js";
import { markdownToIR } from "./ir.js";
import { renderMarkdownWithAttributedRanges } from "./render-attributed.js";
import { renderMarkdownAsPlainText } from "./render-plain.js";
import { renderMarkdownWithMarkers } from "./render.js";

const ALL_NATIVE = {
  mechanism: "markdown",
  constructs: {
    bold: "native",
    italic: "native",
    underline: "native",
    strikethrough: "native",
    spoiler: "native",
    codeInline: "native",
    codeBlock: "native",
    codeLanguage: "native",
    linkLabel: "native",
    heading: "native",
    bulletList: "native",
    orderedList: "native",
    taskList: "native",
    table: "native",
    blockquote: "native",
    image: "native",
    mention: "native",
  },
  chunk: { limit: 4_000, unit: "chars" },
} satisfies FormatCapabilityProfile;

describe("format capability driver plumbing", () => {
  const ir = markdownToIR("**See [docs](https://example.com)**", { headingStyle: "rich" });

  it("keeps marker rendering byte-identical for an all-native optional profile", () => {
    const options = {
      styleMarkers: { bold: { open: "<b>", close: "</b>" } },
      escapeText: (text: string) => text,
      buildLink: (link: { start: number; end: number; href: string }) => ({
        start: link.start,
        end: link.end,
        open: "<a>",
        close: "</a>",
      }),
    };
    expect(renderMarkdownWithMarkers(ir, options, ALL_NATIVE)).toBe(
      renderMarkdownWithMarkers(ir, options),
    );
  });

  it("preserves caller-constructed style spans for an all-native profile", () => {
    const customIr = {
      text: "same",
      styles: [
        { start: 0, end: 2, style: "bold" as const },
        { start: 2, end: 4, style: "bold" as const },
      ],
      links: [],
    };
    const options = {
      styleMarkers: { bold: { open: "*", close: "*" } },
      escapeText: (text: string) => text,
    };
    expect(renderMarkdownWithMarkers(customIr, options, ALL_NATIVE)).toBe(
      renderMarkdownWithMarkers(customIr, options),
    );
  });

  it("keeps attributed rendering byte-identical for an all-native optional profile", () => {
    const options = { styleMap: { bold: "strong" as const }, renderLink: () => " (url)" };
    expect(renderMarkdownWithAttributedRanges(ir, options, ALL_NATIVE)).toEqual(
      renderMarkdownWithAttributedRanges(ir, options),
    );
  });

  it("keeps plain projection byte-identical for an all-native optional profile", () => {
    expect(renderMarkdownAsPlainText(ir, {}, ALL_NATIVE)).toBe(renderMarkdownAsPlainText(ir));
  });

  it("keeps explicit label-only link projection above profile fallback", () => {
    const profile = {
      ...ALL_NATIVE,
      constructs: { ...ALL_NATIVE.constructs, linkLabel: "fallback" as const },
    };
    expect(renderMarkdownAsPlainText(ir, { linkStyle: "label" }, profile)).toBe("See docs");
  });
});

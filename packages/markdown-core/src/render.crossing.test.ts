import { describe, expect, it } from "vitest";
import { markdownToIR } from "./ir.js";
import { renderMarkdownWithMarkers } from "./render.js";

describe("renderMarkdownWithMarkers crossing spans", () => {
  it.each([
    {
      name: "a style ending inside a spoiler",
      markdown: "**A ||B** C|| D",
      html: "<b>A <tg-spoiler>B</tg-spoiler></b><tg-spoiler> C</tg-spoiler> D",
    },
    {
      name: "a spoiler ending inside a style",
      markdown: "||A **B|| C** D",
      html: "<tg-spoiler>A <b>B</b></tg-spoiler><b> C</b> D",
    },
    {
      name: "a link ending inside a spoiler",
      markdown: "[A ||B](https://example.com) C|| D",
      html: '<a href="https://example.com">A <tg-spoiler>B</tg-spoiler></a><tg-spoiler> C</tg-spoiler> D',
    },
    {
      name: "multiple styles ending inside a spoiler",
      markdown: "**_A ||B_** C|| D",
      html: "<b><i>A <tg-spoiler>B</tg-spoiler></i></b><tg-spoiler> C</tg-spoiler> D",
    },
  ])("preserves the text and formatting of $name", ({ markdown, html }) => {
    const ir = markdownToIR(markdown, { enableSpoilers: true });
    expect(
      renderMarkdownWithMarkers(ir, {
        styleMarkers: {
          bold: { open: "<b>", close: "</b>" },
          italic: { open: "<i>", close: "</i>" },
          spoiler: { open: "<tg-spoiler>", close: "</tg-spoiler>" },
        },
        escapeText: (text) => text,
        buildLink: (link) => ({
          start: link.start,
          end: link.end,
          open: `<a href="${link.href}">`,
          close: "</a>",
        }),
      }),
    ).toBe(html);
  });
});

describe("renderMarkdownWithMarkers code content", () => {
  it.each([
    {
      name: "terminal inline code",
      markdown: "Copy `name `",
      html: "Copy <code>name </code>",
    },
    {
      name: "terminal inline code in a link label",
      markdown: "[`name `](https://example.com)",
      html: '<a href="https://example.com"><code>name </code></a>',
    },
    {
      name: "inline code followed by prose",
      markdown: "Copy `name ` next",
      html: "Copy <code>name </code> next",
    },
  ])("renders authored code whitespace: $name", ({ markdown, html }) => {
    expect(
      renderMarkdownWithMarkers(markdownToIR(markdown), {
        styleMarkers: { code: { open: "<code>", close: "</code>" } },
        escapeText: (text) => text,
        buildLink: (link) => ({
          start: link.start,
          end: link.end,
          open: `<a href="${link.href}">`,
          close: "</a>",
        }),
      }),
    ).toBe(html);
  });
});

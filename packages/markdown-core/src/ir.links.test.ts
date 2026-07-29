import { describe, expect, it } from "vitest";
import { markdownToIR, sliceMarkdownIR, type MarkdownIR } from "./ir.js";
import { renderMarkdownWithMarkers } from "./render.js";

function collectRenderedLinks(ir: MarkdownIR) {
  const links: Array<{ href: string; label: string; origin: "authored" | "linkify" }> = [];
  renderMarkdownWithMarkers(ir, {
    styleMarkers: {},
    escapeText: (text) => text,
    buildLink: (link, text, context) => {
      links.push({
        href: link.href,
        label: text.slice(link.start, link.end),
        origin: context.origin,
      });
      return null;
    },
  });
  return links;
}

describe("markdownToIR link provenance", () => {
  it("keeps provenance out of the public link span while exposing it to renderers", () => {
    const ir = markdownToIR("README.md [main.ts](https://main.ts)");

    expect(ir.links).toEqual([
      { start: 0, end: 9, href: "http://README.md" },
      { start: 10, end: 17, href: "https://main.ts" },
    ]);
    expect(collectRenderedLinks(ir)).toEqual([
      { href: "http://README.md", label: "README.md", origin: "linkify" },
      { href: "https://main.ts", label: "main.ts", origin: "authored" },
    ]);
  });

  it("preserves link provenance through slicing", () => {
    const ir = markdownToIR("prefix README.md suffix");

    expect(collectRenderedLinks(sliceMarkdownIR(ir, 7, 16))).toEqual([
      { href: "http://README.md", label: "README.md", origin: "linkify" },
    ]);
  });

  it("preserves link provenance through table rendering", () => {
    const ir = markdownToIR("| File |\n| --- |\n| README.md |", { tableMode: "bullets" });

    expect(collectRenderedLinks(ir)).toContainEqual({
      href: "http://README.md",
      label: "README.md",
      origin: "linkify",
    });
  });

  it("tells escapeText when it is inside an auto-link", () => {
    const ir = markdownToIR("see https://example.com/?a=1&b=2 ok", { linkify: true });
    const calls: Array<{ text: string; inAutoLink?: boolean }> = [];
    renderMarkdownWithMarkers(ir, {
      styleMarkers: {},
      escapeText: (text, context) => {
        calls.push({ text, inAutoLink: context?.inAutoLink });
        return text;
      },
      buildLink: (link, text, context) => ({
        start: link.start,
        end: link.end,
        open: `<a href="${link.href}">`,
        close: "</a>",
      }),
    });

    expect(calls).toEqual([
      { text: "see ", inAutoLink: undefined },
      { text: "https://example.com/?a=1&b=2", inAutoLink: true },
      { text: " ok", inAutoLink: undefined },
    ]);
  });

  it("does not mark authored link text as inAutoLink", () => {
    const ir = markdownToIR("[A & B](https://example.com/?a=1&b=2)");
    const calls: Array<{ text: string; inAutoLink?: boolean }> = [];
    renderMarkdownWithMarkers(ir, {
      styleMarkers: {},
      escapeText: (text, context) => {
        calls.push({ text, inAutoLink: context?.inAutoLink });
        return text;
      },
      buildLink: (link, text) => ({
        start: link.start,
        end: link.end,
        open: `<a href="${link.href}">`,
        close: "</a>",
      }),
    });

    expect(calls).toContainEqual({
      text: "A & B",
      inAutoLink: undefined,
    });
  });
});

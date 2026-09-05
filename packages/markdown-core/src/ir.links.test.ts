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
});

describe("markdownToIR file: and scheme handling (#137705)", () => {
  it("parses file: links into a MarkdownLinkSpan so renderers can collapse them", () => {
    const ir = markdownToIR("see [config](file:///etc/config.yaml)");

    expect(ir.links).toEqual([{ start: 4, end: 10, href: "file:///etc/config.yaml" }]);
    // The link reaches buildLink; a channel that returns null collapses it to
    // the label text instead of leaking the raw markdown.
    expect(collectRenderedLinks(ir)).toEqual([
      { href: "file:///etc/config.yaml", label: "config", origin: "authored" },
    ]);
  });

  it("keeps javascript: and vbscript: destinations rejected at the IR layer", () => {
    for (const scheme of ["javascript:", "vbscript:"]) {
      const ir = markdownToIR(`[x](${scheme}alert(1))`);
      expect(ir.links).toEqual([]);
      expect(collectRenderedLinks(ir)).toEqual([]);
    }
  });

  it("admits only data:image embedded images, rejecting other data: URIs", () => {
    // Safe embedded images reach the image handler (no link span).
    const image = markdownToIR("![alt](data:image/png;base64,AAAA)");
    expect(image.links).toEqual([]);

    // Non-image data: URIs stay rejected at the IR layer.
    const text = markdownToIR("[x](data:text/html,<script>)");
    expect(text.links).toEqual([]);
    expect(collectRenderedLinks(text)).toEqual([]);
  });
});

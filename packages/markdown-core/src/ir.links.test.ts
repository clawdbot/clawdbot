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

it("file:// scheme constructs a link span instead of leaking raw markdown", () => {
  // Before the fix, markdown-it's default `validateLink` rejected file:/// and
  // the raw `[label](file:///...)` syntax survived verbatim in `ir.text`, so
  // every downstream renderer leaked it. The IR layer now constructs the span;
  // the render-layer allowlist collapses the non-allowlist href to label text.
  const ir = markdownToIR("see [Nova_Core.md](file:///home/x/Nova_Core.md) ok");
  expect(ir.links).toEqual([{ start: 4, end: 16, href: "file:///home/x/Nova_Core.md" }]);
  expect(ir.text).toBe("see Nova_Core.md ok");
});

it("javascript: scheme stays rejected at the IR layer to prevent XSS", () => {
  // Script-execution schemes stay rejected even though we now allow file://
  // and other non-executable schemes. Letting javascript: through would risk
  // a channel renderer emitting a clickable `<a href="javascript:...">`.
  const ir = markdownToIR("see [a](javascript:alert(1)) ok");
  expect(ir.links).toEqual([]);
});

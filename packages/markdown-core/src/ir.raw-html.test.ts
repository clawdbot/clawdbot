import { describe, expect, it } from "vitest";
import { appendMarkdownIR, markdownToIR, markdownToIRWithMeta, sliceMarkdownIR } from "./ir.js";
import { renderMarkdownIRChunksWithinLimit } from "./render-aware-chunking.js";

describe("markdownToIR raw HTML", () => {
  describe.each([undefined, false])("authored attribute grammar with linkify=%s", (linkify) => {
    it.each([
      "<b data-value=x&#61;1>",
      '<b title="&quot;x&quot;">',
      '<b title="**label** &amp; ||part||">',
      '<b title="first line\nsecond line &amp; **label**">',
      '<b title="Example\nuser[Thu] note">',
    ])("preserves authored attribute grammar before decoding: %s", (opening) => {
      const ir = markdownToIR(`${opening}**body**</b>`, {
        enableSpoilers: true,
        assistantTranscriptRoleHeaders: true,
        linkify,
      });

      expect(ir.text).toBe(`${opening}body</b>`);
      expect(ir.styles).toEqual([
        { start: opening.length, end: opening.length + 4, style: "bold" },
      ]);
      expect(ir.htmlTags).toEqual([
        {
          start: 0,
          end: opening.length,
          raw: opening,
          name: "b",
          closing: false,
          selfClosing: false,
        },
        {
          start: opening.length + 4,
          end: opening.length + 8,
          raw: "</b>",
          name: "b",
          closing: true,
          selfClosing: false,
        },
      ]);
    });
  });

  it("keeps a complete opaque lexeme intact without inner tag facts", () => {
    const raw = "<!-- **note**\nuser[Thu] &amp; <b>inside</b> -->";
    const ir = markdownToIR(`before ${raw} after`, { assistantTranscriptRoleHeaders: true });

    expect(ir.text).toBe(`before ${raw} after`);
    expect(ir.styles).toEqual([]);
    expect(ir.htmlTags).toBeUndefined();
  });

  it.each([false, true])(
    "preserves raw anchor body autolinks with underline=%s",
    (enableHtmlUnderline) => {
      const ir = markdownToIR(
        '<a href="https://example.com/">https://example.com/body **bold**</a>',
        {
          enableHtmlUnderline,
        },
      );

      expect(ir.links.map((link) => ir.text.slice(link.start, link.end))).toEqual([
        "https://example.com/body",
      ]);
      expect(ir.styles.map((span) => ir.text.slice(span.start, span.end))).toEqual(["bold"]);
    },
  );

  it.each(["r", "&#114;"])("keeps Markdown links in incomplete HTML syntax: %s", (label) => {
    const ir = markdownToIR(`<b[${label}](https://example.com)>tail`);

    expect(ir.text).toBe("<br>tail");
    expect(ir.styles).toEqual([]);
    expect(ir.links).toEqual([{ start: 2, end: 3, href: "https://example.com" }]);
    expect(ir.htmlTags).toBeUndefined();
  });

  it.each(["<b>diagram</b>", "&lt;b&gt;diagram&lt;/b&gt;", "\\<b>diagram\\</b>"])(
    "keeps image alternatives plain without changing their text: %s",
    (label) => {
      const ir = markdownToIR(`before **![${label}](https://example.com/diagram.png)** after`);

      expect(ir.text).toBe(`before ${label} after`);
      expect(ir.styles).toEqual([{ start: 7, end: 7 + label.length, style: "bold" }]);
      expect(ir.htmlTags).toBeUndefined();
    },
  );

  it.each([
    "&lt;b&gt;**literal**&lt;/b&gt; tail",
    "&#60;b&#62;**literal**&#x3c;/b&#x3e; tail",
    "\\<b\\>**literal**\\</b\\> tail",
  ])("does not classify decoded literal text as authored HTML: %s", (source) => {
    const ir = markdownToIR(source);

    expect(ir.text).toBe("<b>literal</b> tail");
    expect(ir.styles).toEqual([{ start: 3, end: 10, style: "bold" }]);
    expect(ir.htmlTags).toBeUndefined();
    expect(Object.keys(ir)).toEqual(["text", "styles", "links"]);
    const serialized = JSON.stringify(ir);
    expect(JSON.parse(serialized)).toEqual({
      text: "<b>literal</b> tail",
      styles: [{ start: 3, end: 10, style: "bold" }],
      links: [],
    });
  });

  it("keeps authored tags aligned through spoiler token splitting", () => {
    const ir = markdownToIR("before <b>x</b> ||<i>y</i>|| after", { enableSpoilers: true });

    expect(ir.text).toBe("before <b>x</b> <i>y</i> after");
    expect(ir.styles).toEqual([{ start: 16, end: 24, style: "spoiler" }]);
    expect(ir.htmlTags).toEqual([
      { start: 7, end: 10, raw: "<b>", name: "b", closing: false, selfClosing: false },
      { start: 11, end: 15, raw: "</b>", name: "b", closing: true, selfClosing: false },
      { start: 16, end: 19, raw: "<i>", name: "i", closing: false, selfClosing: false },
      { start: 20, end: 24, raw: "</i>", name: "i", closing: true, selfClosing: false },
    ]);
  });

  it("transfers only whole tags with the text's complete code points", () => {
    const source = markdownToIR("a🐱<b>x</b>");
    const sliced = sliceMarkdownIR(source, 2, 6);
    const target = markdownToIR("prefix");
    appendMarkdownIR(target, sliced);

    expect(sliced.text).toBe("🐱<b>");
    expect(target.text).toBe("prefix🐱<b>");
    expect(target.htmlTags).toEqual([
      { start: 8, end: 11, raw: "<b>", name: "b", closing: false, selfClosing: false },
    ]);
    expect(source.htmlTags?.[0]?.start).toBe(3);
    expect(sliceMarkdownIR(source, 4, 6).htmlTags).toBeUndefined();
    expect(Object.keys(target)).not.toContain("htmlTags");
    expect(JSON.stringify(target)).not.toContain("htmlTags");
  });

  it("does not turn chunked tag fragments into authored tags", () => {
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir: markdownToIR("a<b>x</b>"),
      limit: 4,
      measureRendered: (text: string) => text.length,
      renderChunk: (ir) => ir.text,
    });

    expect(chunks.map(({ rendered, source }) => ({ rendered, tags: source.htmlTags }))).toEqual([
      {
        rendered: "a<b>",
        tags: [{ start: 1, end: 4, raw: "<b>", name: "b", closing: false, selfClosing: false }],
      },
      { rendered: "x</b", tags: undefined },
      { rendered: ">", tags: undefined },
    ]);
  });

  it("carries authored tags through table cells and bullet projection", () => {
    const source = "| Value |\n| --- |\n| **<b>x</b>** |";
    const { tables } = markdownToIRWithMeta(source, { tableMode: "block" });
    const cell = tables[0]?.rowCells[0]?.[0];
    expect(cell?.text).toBe("<b>x</b>");
    expect(cell?.htmlTags).toEqual([
      { start: 0, end: 3, raw: "<b>", name: "b", closing: false, selfClosing: false },
      { start: 4, end: 8, raw: "</b>", name: "b", closing: true, selfClosing: false },
    ]);
    expect(Object.keys(cell ?? {})).not.toContain("htmlTags");
    const bullets = markdownToIR(source, { tableMode: "bullets" });
    expect(bullets.text).toBe("• Value: <b>x</b>");
    expect(bullets.htmlTags).toEqual([
      { start: 9, end: 12, raw: "<b>", name: "b", closing: false, selfClosing: false },
      { start: 13, end: 17, raw: "</b>", name: "b", closing: true, selfClosing: false },
    ]);
  });

  it("does not linkify URLs inside raw HTML tag attributes", () => {
    const ir = markdownToIR(
      '<img src="https://example.com/diagram.png" alt="Diagram"> https://example.com/page',
    );

    expect(ir.text).toBe(
      '<img src="https://example.com/diagram.png" alt="Diagram"> https://example.com/page',
    );
    expect(ir.links.map((link) => ir.text.slice(link.start, link.end))).toEqual([
      "https://example.com/page",
    ]);
  });

  it("does not treat comparison text as a raw HTML tag", () => {
    const ir = markdownToIR("x < y https://example.com/page");

    expect(ir.links.map((link) => ir.text.slice(link.start, link.end))).toEqual([
      "https://example.com/page",
    ]);
  });
});

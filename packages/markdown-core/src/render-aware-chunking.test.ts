// Markdown Core tests cover render aware chunking behavior.
import { describe, expect, it } from "vitest";
import { FormatCapabilityProfile } from "./format-capabilities.js";
import type { MarkdownIR } from "./ir.js";
import { markdownToIR, sliceMarkdownIR } from "./ir.js";
import { renderMarkdownWithAttributedRanges } from "./render-attributed.js";
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

  it("drops temporary boundary annotations when whitespace is coalesced", () => {
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir: {
        text: `alpha${" ".repeat(19)}\nuser[t] ok`,
        styles: [],
        links: [{ start: 25, end: 32, href: "https://example.test" }],
      },
      limit: 20,
      assistantTranscriptRoleMessageBoundaries: true,
      renderChunk: (source) => ({
        source,
        ...renderMarkdownWithAttributedRanges(source, {
          styleMap: {},
          annotationStyleMap: { assistant_transcript_role: "MONOSPACE" },
        }),
      }),
      measureRendered: (rendered) => rendered.text.length,
    });

    expect(chunks.map((chunk) => chunk.rendered.text)).toEqual([
      `alpha${" ".repeat(15)}`,
      "    \nuser[t] ok",
    ]);
    const final = chunks[1];
    expect(final?.source.annotations).toBeUndefined();
    expect(final?.source.links).toEqual([{ start: 5, end: 12, href: "https://example.test" }]);
    expect(final?.rendered.ranges).toEqual([]);
    expect(final?.rendered.source).toBe(final?.source);
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

describe("rendered semantic whitespace", () => {
  it.each([
    {
      name: "standalone fenced code",
      source: () => markdownToIR("```\n \n```"),
      expectedSource: {
        text: " \n",
        styles: [{ start: 0, end: 2, style: "code_block" }],
        links: [],
      },
      expectedRendered: ["<pre><code> \n</code></pre>"],
    },
    {
      name: "sliced bold content",
      source: () => sliceMarkdownIR(markdownToIR("**a b**"), 1, 2),
      expectedSource: { text: " ", styles: [{ start: 0, end: 1, style: "bold" }], links: [] },
      expectedRendered: ["<b> </b>"],
    },
    {
      name: "sliced authored link",
      source: () => sliceMarkdownIR(markdownToIR("[a b](https://example.com)"), 1, 2),
      expectedSource: {
        text: " ",
        styles: [],
        links: [{ start: 0, end: 1, href: "https://example.com" }],
      },
      expectedRendered: ['<a href="https://example.com"> </a>'],
    },
    {
      name: "sliced transcript annotation",
      source: () =>
        sliceMarkdownIR(
          markdownToIR("user[Thu 2026]", { assistantTranscriptRoleHeaders: true }),
          8,
          9,
        ),
      expectedSource: {
        text: " ",
        styles: [],
        links: [],
        annotations: [
          {
            start: 0,
            end: 1,
            type: "assistant_transcript_role",
            kind: "role_timestamp_bracket",
            role: "user",
          },
        ],
      },
      expectedRendered: ["<code> </code>"],
    },
    {
      name: "unstyled separator control",
      source: (): MarkdownIR => ({ text: " \n", styles: [], links: [] }),
      expectedSource: { text: " \n", styles: [], links: [] },
      expectedRendered: [],
    },
    {
      name: "nonempty fenced code control",
      source: () => markdownToIR("```\nx\n```"),
      expectedSource: {
        text: "x\n",
        styles: [{ start: 0, end: 2, style: "code_block" }],
        links: [],
      },
      expectedRendered: ["<pre><code>x\n</code></pre>"],
    },
  ])("preserves semantic whitespace: $name", ({ source, expectedSource, expectedRendered }) => {
    const ir = source();
    expect(ir).toEqual(expectedSource);
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir,
      limit: 64,
      renderChunk: (chunk) =>
        renderMarkdownWithMarkers(chunk, {
          styleMarkers: {
            bold: { open: "<b>", close: "</b>" },
            code_block: { open: "<pre><code>", close: "</code></pre>" },
          },
          annotationMarkers: { assistant_transcript_role: { open: "<code>", close: "</code>" } },
          escapeText: (text) => text,
          buildLink: (link) => ({
            start: link.start,
            end: link.end,
            open: `<a href="${link.href}">`,
            close: "</a>",
          }),
        }),
      measureRendered: (rendered) => rendered.length,
    });
    expect(chunks.map((chunk) => chunk.rendered)).toEqual(expectedRendered);
    expect(chunks.map((chunk) => chunk.source)).toEqual(
      expectedRendered.length ? [expectedSource] : [],
    );
    expect(chunks.every((chunk) => chunk.rendered.length <= 64)).toBe(true);
  });
});

it("coalesces semantic whitespace into neighboring rendered chunks", () => {
  const text = `alpha${" ".repeat(19)}\nomega\n`;
  const ir = markdownToIR(`\`\`\`\n${text}\`\`\``);
  expect(ir.text).toBe(text);

  const chunks = renderMarkdownIRChunksWithinLimit({
    ir,
    limit: 20,
    renderChunk: (chunk) =>
      renderMarkdownWithAttributedRanges(chunk, { styleMap: { code_block: "MONOSPACE" } }),
    measureRendered: (rendered) => rendered.text.length,
  });

  expect(chunks.map((chunk) => chunk.rendered)).toEqual([
    {
      text: `alpha${" ".repeat(15)}`,
      ranges: [{ start: 0, length: 20, style: "MONOSPACE" }],
    },
    {
      text: `    \nomega\n`,
      ranges: [{ start: 0, length: 11, style: "MONOSPACE" }],
    },
  ]);
  expect(chunks.map((chunk) => chunk.source.text).join("")).toBe(text);
});

it("preserves task-list fallback while coalescing semantic whitespace", () => {
  const paragraph = "A".repeat(18);
  const profile = FormatCapabilityProfile.define({
    mechanism: "markdown",
    constructs: { taskList: "fallback" },
    chunk: { limit: 20, unit: "chars" },
  });
  const chunks = renderMarkdownIRChunksWithinLimit({
    ir: markdownToIR(`**${paragraph}**\n\n- [x] done`, { enableTaskLists: true }),
    limit: profile.chunk.limit,
    renderChunk: (chunk) =>
      renderMarkdownWithMarkers(
        chunk,
        {
          styleMarkers: { bold: { open: "*", close: "*" } },
          escapeText: (text) => text,
        },
        profile,
      ),
    measureRendered: (rendered) => rendered.length,
  });

  expect(chunks.map((chunk) => chunk.rendered)).toEqual([`*${paragraph}*`, "\n\n[x] done"]);
  expect(chunks.every((chunk) => chunk.rendered.length <= profile.chunk.limit)).toBe(true);
});

it("suppresses semantic whitespace when attributed rendering trims it away", () => {
  const ir = markdownToIR("```\n \n```");
  const renderChunk = (chunk: MarkdownIR) =>
    renderMarkdownWithAttributedRanges(chunk, {
      styleMap: { code_block: "MONOSPACE" },
      trimEnd: true,
    });

  expect(renderChunk(ir)).toEqual({ text: "", ranges: [] });
  expect(
    renderMarkdownIRChunksWithinLimit({
      ir,
      limit: 4_000,
      assistantTranscriptRoleMessageBoundaries: true,
      renderChunk,
      measureRendered: (rendered) => rendered.text.length,
    }),
  ).toEqual([]);
});

describe("authored links across coalesced whitespace", () => {
  const href = "https://example.test";
  const paragraph = "A".repeat(78);
  const attributedProfile = FormatCapabilityProfile.define({
    mechanism: "ranges",
    constructs: { linkLabel: "fallback" },
    chunk: { limit: 80, unit: "chars" },
  });

  it.each([
    {
      name: "one authored link across retained whitespace",
      markdown: `[alpha${" ".repeat(80)}omega](${href})`,
      attributed: false,
      expected: [
        `<a href="${href}">alpha${" ".repeat(40)}</a>`,
        `<a href="${href}">${" ".repeat(40)}omega</a>`,
      ],
      linkCounts: [1, 1],
    },
    {
      name: "two adjacent authored links with the same URL",
      markdown: `**${paragraph}**\n\n[a](${href})[b](${href})`,
      attributed: false,
      expected: [`*${paragraph}*`, `\n\n<a href="${href}">a</a><a href="${href}">b</a>`],
      linkCounts: [0, 2],
    },
    {
      name: "one authored link across trimmed whitespace",
      markdown: `[alpha${" ".repeat(240)}omega](${href})`,
      attributed: true,
      expected: [`alpha (${href})`, `omega (${href})`],
      linkCounts: [1, 1],
    },
  ])("preserves $name", ({ markdown, attributed, expected, linkCounts }) => {
    const chunks = renderMarkdownIRChunksWithinLimit({
      ir: markdownToIR(markdown),
      limit: 80,
      renderChunk: (chunk) =>
        attributed
          ? renderMarkdownWithAttributedRanges(
              chunk,
              { styleMap: {}, trimEnd: true },
              attributedProfile,
            ).text
          : renderMarkdownWithMarkers(chunk, {
              styleMarkers: { bold: { open: "*", close: "*" } },
              escapeText: (text) => text,
              buildLink: (link) => ({
                start: link.start,
                end: link.end,
                open: `<a href="${link.href}">`,
                close: "</a>",
              }),
            }),
      measureRendered: (rendered) => rendered.length,
    });

    expect(chunks.map((chunk) => chunk.rendered)).toEqual(expected);
    expect(chunks.map((chunk) => chunk.source.links.length)).toEqual(linkCounts);
    expect(chunks.every((chunk) => chunk.rendered.length <= 80)).toBe(true);
  });
});

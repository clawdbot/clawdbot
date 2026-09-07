import { describe, expect, it } from "vitest";
import { chunkTextRanges } from "./chunk-text.js";
import { markdownToIR, sliceMarkdownIR } from "./ir.js";

// U+1F600 (😀) = 😀 in UTF-16.
const EMOJI = "\u{1F600}";
const LEAD_HIGH = "\uD83D"; // High surrogate for U+1F600
const LEAD_LOW = "\uDE00"; // Low surrogate for U+1F600

function expectWellFormedUtf16(text: string): void {
  expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
}

describe("Markdown parser calls", () => {
  it("keeps document references and changed options local to each parse", () => {
    const options = { linkify: false };
    expect(
      markdownToIR("[ref]: https://example.org/doc\n\n[ref]", options).links.map(
        (link) => link.href,
      ),
    ).toEqual(["https://example.org/doc"]);
    expect(markdownToIR("[ref] example.org", options).links).toEqual([]);

    options.linkify = true;
    expect(markdownToIR("[ref] example.org", options).links.map((link) => link.href)).toEqual([
      "http://example.org",
    ]);
    options.linkify = false;
    expect(markdownToIR("[ref] example.org", options).links).toEqual([]);
  });
});

describe("sliceMarkdownIR surrogate pair boundaries", () => {
  it("expands start boundary backward when it lands on a low surrogate", () => {
    // "a😀b" — UTF-16: [a] [\uD83D] [\uDE00] [b], indices 0-3
    const ir = markdownToIR(`a${EMOJI}b`);
    expect(ir.text[1]).toBe(LEAD_HIGH);
    expect(ir.text[2]).toBe(LEAD_LOW);
    // from=2 points at \uDE00 (LS); should expand to from=1 to include 😀
    const sliced = sliceMarkdownIR(ir, 2, 4);
    expect(sliced.text).toBe(`${EMOJI}b`);
  });

  it("expands end boundary forward when it splits between HS and LS", () => {
    // "a😀b" — UTF-16: [a] [\uD83D] [\uDE00] [b], indices 0-3
    const ir = markdownToIR(`a${EMOJI}b`);
    // to=2 splits between \uD83D (HS) and \uDE00 (LS); should expand to to=3
    const sliced = sliceMarkdownIR(ir, 0, 2);
    expect(sliced.text).toBe(`a${EMOJI}`);
  });

  it("preserves full text when boundaries are already clean", () => {
    const ir = markdownToIR(`a${EMOJI}b`);
    // Clean boundaries that don't split any surrogate pair
    const sliced = sliceMarkdownIR(ir, 0, 4);
    expect(sliced.text).toBe(`a${EMOJI}b`);
  });

  it("leaves boundaries unchanged when start is on a high surrogate", () => {
    const ir = markdownToIR(`a${EMOJI}b`);
    // from=1 points at \uD83D (HS) — start of pair, no adjustment needed
    const sliced = sliceMarkdownIR(ir, 1, 4);
    expect(sliced.text).toBe(`${EMOJI}b`);
  });

  it("handles multiple consecutive surrogate pairs", () => {
    // U+1F600 😀 (😀) + U+1F431 🐱 (🐱)
    // Indices: 0=HS😀, 1=LS😀, 2=HS🐱, 3=LS🐱, len=4
    const cat = "\u{1F431}";
    const ir = markdownToIR(`${EMOJI}${cat}`);
    // from=1 is LS of 😀 → expand backward to 0; to=4 is past end → stays 4
    const sliced = sliceMarkdownIR(ir, 1, 4);
    expect(sliced.text).toBe(`${EMOJI}${cat}`);
  });

  it("preserves empty slice when start === end lands inside a surrogate pair", () => {
    // "a😀b" — UTF-16: [a] [\uD83D] [\uDE00] [b], indices 0-3
    // start=end=2 lands on \uDE00 (LS); must remain empty, not expand to "😀"
    const ir = markdownToIR(`a${EMOJI}b`);
    const sliced = sliceMarkdownIR(ir, 2, 2);
    expect(sliced.text).toBe("");
  });

  it("preserves empty slice when start === end lands on a high surrogate", () => {
    // start=end=1 lands on \uD83D (HS); must remain empty
    const ir = markdownToIR(`a${EMOJI}b`);
    const sliced = sliceMarkdownIR(ir, 1, 1);
    expect(sliced.text).toBe("");
  });

  it("handles negative start index", () => {
    const ir = markdownToIR(`a${EMOJI}b`);
    // from=-2 => len-2 = 2, which is LS; should expand backward to 1
    const sliced = sliceMarkdownIR(ir, -2, 4);
    expect(sliced.text).toBe(`${EMOJI}b`);
  });

  it("preserves native fractional and non-finite slice index semantics", () => {
    const ir = markdownToIR("[**abcd**](https://example.com)");
    const ranges = [
      [-1.5, 4],
      [0, -1.5],
      [1.5, 3.9],
      [Number.NaN, 2],
      [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
    ] as const;

    for (const [start, end] of ranges) {
      const sliced = sliceMarkdownIR(ir, start, end);
      const expected = ir.text.slice(start, end);

      expect(sliced.text).toBe(expected);
      expect(sliced.styles).toEqual([
        expect.objectContaining({ start: 0, end: expected.length, style: "bold" }),
      ]);
      expect(sliced.links).toEqual([
        { start: 0, end: expected.length, href: "https://example.com" },
      ]);
    }
  });

  it("propagates adjusted boundaries to link spans", () => {
    const ir = markdownToIR(`a[${EMOJI}b](https://example.com)`);
    // from=2 is LS, should expand to 1
    const sliced = sliceMarkdownIR(ir, 2, ir.text.length);
    expect(sliced.text).toContain(EMOJI);
    expect(sliced.links.length).toBeGreaterThan(0);
  });

  it("keeps nested link and style spans aligned with the expanded start", () => {
    const href = "https://example.com";
    const ir = markdownToIR(`a[**${EMOJI}b**](${href})`);
    const sliced = sliceMarkdownIR(ir, 2, ir.text.length);

    expect(sliced.text).toBe(`${EMOJI}b`);
    expectWellFormedUtf16(sliced.text);
    expect(sliced.links).toEqual([{ start: 0, end: 3, href }]);
    expect(sliced.styles).toEqual([expect.objectContaining({ start: 0, end: 3, style: "bold" })]);
  });

  it("keeps transcript annotations and links aligned with the expanded end", () => {
    const cat = "\u{1F431}";
    const href = "https://example.com";
    const ir = markdownToIR(`user[Thu 2026-07-02] **A${EMOJI}B** [C${cat}D](${href})`, {
      assistantTranscriptRoleHeaders: true,
    });
    const catStart = ir.text.indexOf(cat);
    const sliced = sliceMarkdownIR(ir, 0, catStart + 1);

    expect(catStart).toBeGreaterThan(0);
    expect(sliced.text).toBe(ir.text.slice(0, catStart + cat.length));
    expectWellFormedUtf16(sliced.text);
    expect(sliced.annotations).toEqual(ir.annotations);
    expect(sliced.styles).toEqual(ir.styles);
    expect(sliced.links).toEqual([
      expect.objectContaining({
        start: ir.links[0]?.start,
        end: sliced.text.length,
        href,
      }),
    ]);
  });

  it("preserves nested list markers when the final item ends inside a surrogate pair", () => {
    const cat = "\u{1F431}";
    const ir = markdownToIR(`- **A${EMOJI}B**\n  - [x] **C${cat}D**`);
    const catStart = ir.text.indexOf(cat);
    const sliced = sliceMarkdownIR(ir, 0, catStart + 1);

    expect(catStart).toBeGreaterThan(0);
    expect(sliced.text).toBe(ir.text.slice(0, catStart + cat.length));
    expectWellFormedUtf16(sliced.text);
    expect(sliced.listItems).toHaveLength(ir.listItems?.length ?? 0);
    expect(sliced.listItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "bullet", depth: 0 }),
        expect.objectContaining({ kind: "bullet", depth: 1 }),
      ]),
    );
    expect(sliced.styles).toEqual(
      expect.arrayContaining([expect.objectContaining({ style: "bold", end: sliced.text.length })]),
    );

    const blocks = Reflect.get(ir, "blocks") as Array<{ start: number; end: number }>;
    const slicedBlocks = Reflect.get(sliced, "blocks") as
      | Array<{ start: number; end: number }>
      | undefined;
    if (blocks?.length) {
      expect(slicedBlocks).toBeDefined();
      expect(
        slicedBlocks?.every((block) => block.start >= 0 && block.end <= sliced.text.length),
      ).toBe(true);
    }
  });

  it("rejoins the existing surrogate-safe transport chunks without duplicating emoji", () => {
    const ir = markdownToIR(`a${EMOJI}b\u{1F431}c`);

    for (const mode of ["hard", "preferred"] as const) {
      for (const limit of [1, 2, 3, 4]) {
        const chunks = chunkTextRanges(ir.text, { limit, mode }).map(({ start, end }) =>
          sliceMarkdownIR(ir, start, end),
        );

        for (const chunk of chunks) {
          expectWellFormedUtf16(chunk.text);
        }
        expect(chunks.map((chunk) => chunk.text).join("")).toBe(ir.text);
      }
    }
  });

  it("preserves normalized empty slice with mixed positive/negative indices", () => {
    // After normalization: start=-1 → from=len-1 which is > to=0 = normalized empty.
    // Surrogate adjustment must not expand this into a non-empty slice.
    const ir = markdownToIR(`a${EMOJI}b`);
    const sliced = sliceMarkdownIR(ir, -1, 0);
    expect(sliced.text).toBe("");
  });
});

describe("Markdown final code content", () => {
  it.each([
    {
      name: "terminal inline code",
      markdown: "Copy `name `",
      expected: {
        text: "Copy name ",
        styles: [{ start: 5, end: 10, style: "code" }],
        links: [],
      },
    },
    {
      name: "terminal inline code in a link label",
      markdown: "[`name `](https://example.com)",
      expected: {
        text: "name ",
        styles: [{ start: 0, end: 5, style: "code" }],
        links: [{ start: 0, end: 5, href: "https://example.com" }],
      },
    },
    {
      name: "standalone one-space inline code",
      markdown: "` `",
      expected: {
        text: " ",
        styles: [{ start: 0, end: 1, style: "code" }],
        links: [],
      },
    },
    {
      name: "standalone three-space inline code",
      markdown: "`   `",
      expected: {
        text: "   ",
        styles: [{ start: 0, end: 3, style: "code" }],
        links: [],
      },
    },
    {
      name: "inline code followed by prose",
      markdown: "Copy `name ` next",
      expected: {
        text: "Copy name  next",
        styles: [{ start: 5, end: 10, style: "code" }],
        links: [],
      },
    },
    {
      name: "ordinary trailing prose whitespace",
      markdown: "Copy name   ",
      expected: { text: "Copy name", styles: [], links: [] },
    },
    {
      name: "fenced code trailing whitespace",
      markdown: "```\nname \n```",
      expected: {
        text: "name \n",
        styles: [{ start: 0, end: 6, style: "code_block" }],
        links: [],
      },
    },
  ])("preserves final code payload: $name", ({ markdown, expected }) => {
    expect(markdownToIR(markdown)).toEqual(expected);
  });
});

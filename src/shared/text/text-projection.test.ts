import { describe, expect, it, vi } from "vitest";
import { findCodeRegions } from "./code-regions.js";
import {
  applyTextFilters,
  createTextProjection,
  duplicateParagraphTextFilter,
  leadingEmptyLinesTextFilter,
  trimTextFilter,
  type TextFilter,
} from "./text-projection.js";

vi.mock("./code-regions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./code-regions.js")>();
  return { ...actual, findCodeRegions: vi.fn(actual.findCodeRegions) };
});

describe("createTextProjection", () => {
  it("activates split markers, reprojects completed syntax, and replaces the source", () => {
    const projection = createTextProjection([
      {
        activationTokens: ["<private>"],
        transform: (text) => text.replace(/<private>[\s\S]*?<\/private>/gi, ""),
      },
    ]);
    expect(projection.append("Before <PRI")).toEqual({ text: "Before <PRI", delta: "Before <PRI" });
    expect(projection.append("VATE>secret")).toEqual({
      text: "Before <PRIVATE>secret",
      delta: "VATE>secret",
    });
    expect(projection.append("</PRIVATE>after")).toEqual({ text: "Before after", delta: null });
    expect(projection.append(".")).toEqual({ text: "Before after.", delta: "." });
    expect(projection.replace("Fresh ")).toEqual({ text: "Fresh ", delta: null });
    expect(projection.append("reply")).toEqual({ text: "Fresh reply", delta: "reply" });
    expect(projection.source).toBe("Fresh reply");
    expect(projection.text).toBe("Fresh reply");
  });

  it("rechecks downstream activation when a preceding filter joins a marker", () => {
    const filters: TextFilter[] = [
      { activationTokens: ["<cut>"], transform: (text) => text.replace(/<cut>.*?<\/cut>/g, "") },
      { activationTokens: ["BEGIN"], transform: (text) => text.replace(/BEGIN.*?END/g, "") },
    ];
    const projection = createTextProjection(filters);
    projection.append("Before BE<cut>hidden");
    expect(projection.append("</cut>GIN private ENDafter")).toEqual({
      text: "Before after",
      delta: null,
    });
    expect(applyTextFilters(projection.source, filters)).toBe("Before after");
  });

  it("preserves an append when downstream filtering cancels an intermediate correction", () => {
    const projection = createTextProjection([
      { activationTokens: ["<cut>"], transform: (text) => text.replace(/<cut>.*?<\/cut>/g, "") },
      { activationTokens: ["<cut>"], transform: (text) => text.replace(/<cut>.*/g, "") },
    ]);
    expect(projection.append("Ready <cut>hidden")).toEqual({ text: "Ready ", delta: "Ready " });
    expect(projection.append("</cut>reply")).toEqual({ text: "Ready reply", delta: "reply" });
    expect(projection.replace("Ready reply")).toEqual({ text: "Ready reply", delta: null });
  });

  it.each(["none", "start", "both"] as const)("trims %s across whitespace boundaries", (mode) => {
    const filter = trimTextFilter(mode);
    const projection = createTextProjection([filter]);
    let source = "";
    let delivered = "";
    for (const delta of [" \r", "\n\u00a0", " A ", "\t", "B\r", "\n", " C", "  "]) {
      source += delta;
      const result = projection.append(delta);
      const expected =
        mode === "both" ? source.trim() : mode === "start" ? source.trimStart() : source;
      expect(result).toEqual({ text: expected, delta: expected.slice(delivered.length) });
      delivered = expected;
    }
    expect(projection.replace(" \tReset \n")).toEqual({
      text: filter.transform(" \tReset \n"),
      delta: null,
    });
    expect(projection.append("end").text).toBe(filter.transform(" \tReset \nend"));
  });

  it.each([
    { chunks: [" \r", "\n\t\n", "  Code", "\n next"], expected: "  Code\n next" },
    { chunks: ["\v", "\n", " Text"], expected: "\v\n Text" },
    { chunks: [" \n\r\n", "\t"], expected: "" },
  ])("removes only leading empty lines %#", ({ chunks, expected }) => {
    const projection = createTextProjection([leadingEmptyLinesTextFilter]);
    let delivered = "";
    for (const chunk of chunks) {
      const result = projection.append(chunk);
      expect(result.delta).not.toBeNull();
      delivered += result.delta;
      expect(delivered).toBe(result.text);
    }
    expect(projection.text).toBe(expected);
    expect(projection.replace("\n  Reset")).toEqual({ text: "  Reset", delta: null });
  });
});

describe("duplicate paragraphs", () => {
  it.each([
    { text: " \r\n\t ", expected: " \r\n\t " },
    { text: "  A \n\n A  ", expected: "A" },
    { text: "A\n\nB\n\nA", expected: "A\n\nB\n\nA" },
    { text: "A  B\n\nA\tB", expected: "A  B" },
    { text: "A\r\n\r\nA", expected: "A\r\n\r\nA" },
    { text: "A\n\nA\n\nB\n\nB", expected: "A\n\nB" },
    { text: "first\n\nfirst diverges\n\nfirst diverges", expected: "first\n\nfirst diverges" },
    { text: "A\n\nA\n\nB C\n\nB\u00a0C", expected: "A\n\nB C" },
    { text: "A\n\n \n\nA", expected: "A\n\n \n\nA" },
    { text: "A\n\nA\n\n \n\nB", expected: "A\n\n\n\nB" },
    { text: "\n\n \n\nA\n\nA\n\n \n\n", expected: "A" },
    {
      text: "```text\nrepeat\n\nrepeat\n```",
      expected: "```text\nrepeat\n\nrepeat\n```",
    },
    {
      text: "    first\n\n    second\n\ntail\n\ntail",
      expected: "    first\n\n    second\n\ntail",
    },
    { text: "repeat\n\n    repeat\n\nrepeat", expected: "repeat\n\n    repeat\n\nrepeat" },
    { text: "Run `x`.\n\nRun `x`.", expected: "Run `x`." },
    {
      text: 'repeat\n\nrepeat\n\n```js\nfunction replacement() {\n\n  return "$$ $& $` $\'";\n}\n```',
      expected: 'repeat\n\n```js\nfunction replacement() {\n\n  return "$$ $& $` $\'";\n}\n```',
    },
    {
      text: '    const replacement = "$$ $& $` $\'";\n\nrepeat\n\nrepeat',
      expected: '    const replacement = "$$ $& $` $\'";\n\nrepeat',
    },
    { text: "Use ``$$ $& $` $'``.\n\nUse ``$$ $& $` $'``.", expected: "Use ``$$ $& $` $'``." },
    { text: "repeat\n\nrepeat `x`", expected: "repeat\n\nrepeat `x`" },
    { text: "Do `x` repeat\n\nrepeat", expected: "Do `x` repeat\n\nrepeat" },
  ])("preserves canonical separators and whitespace %#", ({ text, expected }) => {
    expect(duplicateParagraphTextFilter.transform(text)).toBe(expected);
    const partitions = [
      text.split(""),
      ...Array.from({ length: text.length + 1 }, (_, split) => [
        text.slice(0, split),
        text.slice(split),
      ]),
    ];
    for (const chunks of partitions) {
      const projection = createTextProjection([duplicateParagraphTextFilter]);
      let delivered = "";
      for (const chunk of chunks) {
        const result = projection.append(chunk);
        delivered = result.delta === null ? result.text : delivered + result.delta;
        expect(delivered).toBe(result.text);
      }
      expect(projection.text).toBe(expected);
    }
  });

  it.each([
    {
      initial: "A\n\n\nB\n\nB",
      initialText: "A\n\nB",
      appended: " changes",
      expected: { text: "A\n\n\nB\n\nB changes", delta: null },
    },
    {
      initial: "first\n\nfirst",
      initialText: "first",
      appended: " diverges\n\nfirst diverges",
      expected: { text: "first\n\nfirst diverges", delta: "\n\nfirst diverges" },
    },
  ])(
    "reconciles a provisional duplicate as later paragraphs diverge %#",
    ({ initial, initialText, appended, expected }) => {
      const projection = createTextProjection([duplicateParagraphTextFilter]);
      expect(projection.append(initial)).toEqual({ text: initialText, delta: initialText });
      expect(projection.append(appended)).toEqual(expected);
      expect(projection.replace("  New\n\nNew")).toEqual({ text: "New", delta: null });
      expect(projection.append("\n\nLast ")).toEqual({ text: "New\n\nLast", delta: "\n\nLast" });
      expect(projection.append("word")).toEqual({ text: "New\n\nLast word", delta: " word" });
    },
  );

  it("keeps code-bearing continuation appends on the incremental suffix path", () => {
    const parser = vi.mocked(findCodeRegions);
    parser.mockClear();
    const code = "```text\ninside\n\ninside\n```";
    const source = `${code}\n\nrepeat\n\nrepeat\n\ntail`;
    const projection = createTextProjection([duplicateParagraphTextFilter]);
    expect(projection.append(source).text).toBe(`${code}\n\nrepeat\n\ntail`);
    const initialParses = parser.mock.calls.length;
    expect(initialParses).toBeGreaterThan(0);

    for (let index = 0; index < 256; index++) {
      const delta = `-${index}`;
      expect(projection.append(delta).delta).toBe(delta);
    }
    expect(parser).toHaveBeenCalledTimes(initialParses);
    expect(projection.text).toBe(duplicateParagraphTextFilter.transform(projection.source));
  });
});

// Covers streaming chunk boundaries for embedded-agent text blocks.
import { describe, expect, it, vi } from "vitest";
import * as fences from "../../packages/markdown-core/src/fences.js";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";

function createFlushOnParagraphChunker(params: { minChars: number; maxChars: number }) {
  return new EmbeddedBlockChunker({
    minChars: params.minChars,
    maxChars: params.maxChars,
    breakPreference: "paragraph",
    flushOnParagraph: true,
  });
}

function drainChunks(chunker: EmbeddedBlockChunker, force = false) {
  const chunks: string[] = [];
  chunker.drain({ force, emit: (chunk) => chunks.push(chunk) });
  return chunks;
}

function expectChunksWithinLength(chunks: string[], maxLength: number) {
  expect(
    chunks
      .map((chunk, index) => ({ index, length: chunk.length }))
      .filter((entry) => entry.length > maxLength),
  ).toStrictEqual([]);
}

describe("EmbeddedBlockChunker", () => {
  it.each([
    { tail: "Tail", changed: false, expected: ["Tail"] },
    { tail: "", changed: true, expected: [] },
    { tail: "Fixed tail", changed: true, expected: ["Fixed tail"] },
  ])(
    "reconciles pending '$tail' without replaying drained source",
    ({ tail, changed, expected }) => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 10,
        maxChars: 16,
        breakPreference: "sentence",
      });
      for (const sentence of ["Hello world.", "Next sentence."]) {
        chunker.append(`${sentence} `);
        expect(drainChunks(chunker)).toEqual([sentence]);
      }
      chunker.append("Tail");
      expect(chunker.consumedLength).toBe("Hello world. Next sentence. ".length);
      const snapshot = `Hello world. Next sentence.${tail ? ` ${tail}` : ""}`;

      expect(chunker.replace(snapshot)).toBe(changed);
      expect(chunker.sourceLength).toBe(snapshot.length);
      expect(drainChunks(chunker, true)).toEqual(expected);
      expect(chunker.consumedLength).toBe(snapshot.length);
      expect(chunker.replace(snapshot)).toBe(false);
      expect(drainChunks(chunker, true)).toEqual([]);
    },
  );

  it("buffers without chunking and replaces a native source suffix before or after a drain", () => {
    const chunker = new EmbeddedBlockChunker();
    chunker.append("Earlier ");
    const sourceOffset = chunker.sourceLength;
    chunker.append("Draft");
    expect(drainChunks(chunker)).toEqual([]);
    expect(chunker.replace("Fixed", sourceOffset)).toBe(true);
    expect(drainChunks(chunker, true)).toEqual(["Earlier Fixed"]);
    expect(chunker.consumedLength).toBe("Earlier Fixed".length);

    const nextOffset = chunker.sourceLength;
    chunker.append("Draft");
    expect(chunker.replace("Later", nextOffset)).toBe(true);
    expect(drainChunks(chunker, true)).toEqual(["Later"]);
    chunker.reset();
    expect(chunker.sourceLength).toBe(0);
    expect(chunker.consumedLength).toBe(0);
    chunker.append(" \n");
    expect(drainChunks(chunker, true)).toEqual([" \n"]);
  });

  it.each(
    [
      {
        name: "regular",
        header: "```txt\n",
        renderedHeader: "```txt\n",
        body: "x".repeat(9),
        tail: "xxx😀tail",
        maxChars: 20,
      },
      {
        name: "long-language",
        header: "```very-long-language-name\n",
        renderedHeader: "```\n",
        body: "q".repeat(22),
        tail: "qqqq\nold\n```",
        maxChars: 30,
      },
    ].flatMap((fixture) =>
      ["NEW", ""].map((replacement) => Object.assign({}, fixture, { replacement })),
    ),
  )(
    "reconciles $name fenced source with '$replacement' pending code",
    ({ header, renderedHeader, body, tail, maxChars, replacement }) => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 10,
        maxChars,
        breakPreference: "paragraph",
      });
      chunker.append(`${header}${body}${tail}`);
      expect(drainChunks(chunker)).toEqual([`${renderedHeader}${body}\n\`\`\``]);
      expect(chunker.consumedLength).toBe(header.length + body.length);

      const snapshot = `${header}${body}${replacement}\n\`\`\``;
      expect(chunker.replace(snapshot)).toBe(true);
      expect(chunker.sourceLength).toBe(snapshot.length);
      expect(chunker.bufferedText).toBe(`${renderedHeader}${replacement}\n\`\`\``);
      expect(drainChunks(chunker, true)).toEqual(
        replacement ? [`${renderedHeader}${replacement}\n\`\`\``] : [],
      );
      expect(chunker.consumedLength).toBe(snapshot.length);
    },
  );

  it("counts the source closing fence and skipped paragraph separator before replacing prose", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 30,
      breakPreference: "paragraph",
    });
    const prefix = `\`\`\`txt\n${"q".repeat(32)}\n\`\`\`\n\n`;
    chunker.append(`${prefix}Tail`);
    expect(drainChunks(chunker)).toEqual([
      `\`\`\`txt\n${"q".repeat(19)}\n\`\`\``,
      `\`\`\`txt\n${"q".repeat(13)}\n\`\`\``,
    ]);
    expect(chunker.consumedLength).toBe(prefix.length);
    expect(chunker.replace(`${prefix}Fixed`)).toBe(true);
    expect(drainChunks(chunker, true)).toEqual(["Fixed"]);
  });

  it("breaks at paragraph boundary right after fence close", () => {
    // A closed fence is a safe boundary; splitting before it would corrupt
    // markdown rendered by downstream clients.
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 40,
      breakPreference: "paragraph",
    });

    const text = [
      "Intro",
      "```js",
      "console.log('x')",
      "```",
      "",
      "After first line",
      "After second line",
    ].join("\n");

    chunker.append(text);

    const chunks = drainChunks(chunker);

    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("console.log");
    expect(chunks[0]).toMatch(/```\n?$/);
    expect(chunks[0]).not.toContain("After");
    expect(chunker.bufferedText).toMatch(/^After/);
  });

  it("waits until minChars before flushing paragraph boundaries when flushOnParagraph is set", () => {
    const chunker = createFlushOnParagraphChunker({ minChars: 30, maxChars: 200 });

    chunker.append("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");

    const chunks = drainChunks(chunker);

    expect(chunks).toEqual(["First paragraph.\n\nSecond paragraph."]);
    expect(chunker.bufferedText).toBe("Third paragraph.");
  });

  it("still force flushes buffered paragraphs below minChars at the end", () => {
    const chunker = createFlushOnParagraphChunker({ minChars: 100, maxChars: 200 });

    chunker.append("First paragraph.\n \nSecond paragraph.");

    expect(drainChunks(chunker)).toStrictEqual([]);
    expect(drainChunks(chunker, true)).toEqual(["First paragraph.\n \nSecond paragraph."]);
    expect(chunker.bufferedText).toBe("");
  });

  it("falls back to maxChars when flushOnParagraph is set and no paragraph break exists", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 10,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("abcdefghijKLMNOP");

    const chunks = drainChunks(chunker);

    expect(chunks).toEqual(["abcdefghij"]);
    expect(chunker.bufferedText).toBe("KLMNOP");
  });

  it("keeps forced maxChars chunks valid at UTF-16 boundaries", () => {
    const plainChunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 20,
      breakPreference: "paragraph",
    });
    plainChunker.append(`${"x".repeat(19)}😀tail`);

    expect(drainChunks(plainChunker)).toEqual(["x".repeat(19)]);
    expect(plainChunker.bufferedText).toBe("😀tail");

    const tinyChunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 1,
      breakPreference: "paragraph",
    });
    tinyChunker.append("😀tail");

    expect(drainChunks(tinyChunker)).toEqual(["😀", "t", "a", "i", "l"]);
    expect(tinyChunker.bufferedText).toBe("");

    const fencedChunker = new EmbeddedBlockChunker({
      minChars: 10,
      maxChars: 20,
      breakPreference: "paragraph",
    });
    fencedChunker.append(`\`\`\`txt\n${"x".repeat(12)}😀tail`);

    expect(drainChunks(fencedChunker)).toEqual([`\`\`\`txt\n${"x".repeat(9)}\n\`\`\``]);
    expect(fencedChunker.bufferedText).toBe("```txt\nxxx😀tail");
  });

  it("clamps long paragraphs to maxChars when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 10,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("abcdefghijk\n\nRest");

    const chunks = drainChunks(chunker);

    expectChunksWithinLength(chunks, 10);
    expect(chunks).toEqual(["abcdefghij", "k"]);
    expect(chunker.bufferedText).toBe("Rest");
  });

  it("ignores paragraph breaks inside fences when flushOnParagraph is set", () => {
    // Blank lines inside fenced code are content, not paragraph boundaries.
    const chunker = new EmbeddedBlockChunker({
      minChars: 10,
      maxChars: 200,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    const text = [
      "Intro",
      "```js",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "After fence",
    ].join("\n");

    chunker.append(text);

    const chunks = drainChunks(chunker);

    expect(chunks).toEqual(["Intro\n```js\nconst a = 1;\n\nconst b = 2;\n```"]);
    expect(chunker.bufferedText).toBe("After fence");
  });

  it("parses fence spans once per drain call for long fenced buffers", () => {
    // Long streaming buffers should not rescan fences for every emitted chunk.
    const parseSpy = vi.spyOn(fences, "parseFenceSpans");
    const chunker = new EmbeddedBlockChunker({
      minChars: 20,
      maxChars: 80,
      breakPreference: "paragraph",
    });

    chunker.append(`\`\`\`txt\n${"line\n".repeat(600)}\`\`\``);
    const chunks = drainChunks(chunker);

    expect(chunks.length).toBeGreaterThan(2);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    parseSpy.mockRestore();
  });

  it("does not split inside the closing fence marker when clamping at maxChars", () => {
    // Clamp-based splitting rewraps fenced chunks so no partial closing marker
    // leaks into the stream.
    const chunker = new EmbeddedBlockChunker({
      minChars: 10,
      maxChars: 30,
      breakPreference: "paragraph",
    });

    chunker.append(`\`\`\`txt\n${"a".repeat(80)}\n\`\`\``);
    const chunks = drainChunks(chunker, true);

    expectChunksWithinLength(chunks, 30);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("").match(/a/g)?.length).toBe(80);
    for (const chunk of chunks) {
      expect(chunk.startsWith("```txt")).toBe(true);
      expect(chunk.match(/```/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(chunk).not.toContain("``\n```");
      expect(chunk).not.toMatch(/^```txt\n```\n?$/);
    }
  });

  it.each([
    { marker: "```", finalLine: "XXXXXXXX", force: true },
    { marker: "~~~", finalLine: "XXXXXXXX", force: true },
    { marker: "  ```", finalLine: "XXXXXXXX", force: true },
    { marker: "````", finalLine: "XXXXXXXX", force: true },
    { marker: "```", finalLine: "😀😀😀😀", force: true },
    { marker: "```", finalLine: "``` XXXXXXXX", force: true },
    { marker: "```", finalLine: "~~~ XXXXXXXX", force: true },
    { marker: "```", finalLine: "    ``` XXXXXXXX", force: true },
    { marker: "```", finalLine: "XXXXXXXX", force: false },
    { marker: "~~~", finalLine: "XXXXXXXX", force: false },
  ])(
    "preserves the final content line in an unfinished $marker fence (force: $force)",
    ({ marker, finalLine, force }) => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 20,
        breakPreference: "paragraph",
      });
      chunker.append(`${marker}txt\n12345678\n${finalLine}`);

      const chunks = drainChunks(chunker, force);
      if (!force) {
        chunks.push(...drainChunks(chunker, true));
      }

      expectChunksWithinLength(chunks, 20);
      const contentCodePoint = finalLine.includes("😀") ? "😀" : "X";
      expect(
        Array.from(chunks.join("")).filter((value) => value === contentCodePoint),
      ).toHaveLength(Array.from(finalLine).filter((value) => value === contentCodePoint).length);
      expect(chunker.bufferedText).toBe("");
    },
  );

  it.each([
    { marker: "```", closingMarker: "`````" },
    { marker: "```", closingMarker: "   ``` \t" },
    { marker: "~~~", closingMarker: " ~~~~\t" },
    { marker: "  ```", closingMarker: "```" },
    { marker: "```", closingMarker: "```\r" },
  ])("recognizes valid $marker closing-fence variants", ({ marker, closingMarker }) => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 20,
      breakPreference: "paragraph",
    });
    chunker.append(`${marker}txt\n${"q".repeat(32)}\n${closingMarker}`);

    const chunks = drainChunks(chunker, true);

    expectChunksWithinLength(chunks, 20);
    expect(chunks.join("").match(/q/g)).toHaveLength(32);
    expect(chunks.every((chunk) => chunk.includes("q"))).toBe(true);
    expect(chunker.bufferedText).toBe("");
  });

  it.each([
    { name: "default", maxChars: 1_200, bodyChars: 2_383, marker: "```" },
    { name: "Discord", maxChars: 2_000, bodyChars: 3_983, marker: "```" },
    { name: "Telegram", maxChars: 4_000, bodyChars: 7_983, marker: "```" },
    { name: "tilde", maxChars: 30, bodyChars: 83, marker: "~~~" },
    { name: "indented", maxChars: 40, bodyChars: 83, marker: "  ```" },
  ])(
    "keeps $name fenced replies within their actual message budget",
    ({ maxChars, bodyChars, marker }) => {
      const chunker = new EmbeddedBlockChunker({
        minChars: Math.min(800, maxChars),
        maxChars,
        breakPreference: "paragraph",
      });
      chunker.append(`${marker}typescript\n${"x".repeat(bodyChars)}\n${marker}`);

      const chunks = drainChunks(chunker, true);

      expectChunksWithinLength(chunks, maxChars);
      expect(chunks.join("").match(/x/g)?.length).toBe(bodyChars);
      expect(chunks).not.toContain(`${marker}typescript\n${marker}`);
      for (const chunk of chunks) {
        expect(chunk.startsWith(`${marker}typescript\n`)).toBe(true);
        expect(chunk.trimEnd().endsWith(marker)).toBe(true);
      }
    },
  );

  it("degrades oversized fence language markers without turning them into code", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 10,
      maxChars: 30,
      breakPreference: "paragraph",
    });
    const body = "q".repeat(70);
    chunker.append(`\`\`\`very-long-language-name\n${body}\n\`\`\``);

    const chunks = drainChunks(chunker, true);

    expectChunksWithinLength(chunks, 30);
    expect(chunks[0]).toMatch(/^```\n/);
    expect(
      chunks.map((chunk) => chunk.trimEnd().split("\n").slice(1, -1).join("\n")).join(""),
    ).toBe(body);
  });

  it.each([
    { maxChars: 9, marker: "```", language: "" },
    { maxChars: 11, marker: "```", language: "js" },
    { maxChars: 11, marker: "````", language: "" },
    { maxChars: 13, marker: "````", language: "js" },
  ])(
    "honors the smallest balanced $marker fence at $maxChars characters",
    ({ maxChars, marker, language }) => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars,
        breakPreference: "paragraph",
      });
      chunker.append(`${marker}${language}\n${"a".repeat(21)}\n${marker}`);

      const chunks = drainChunks(chunker, true);

      expectChunksWithinLength(chunks, maxChars);
      expect(chunks.join("").match(/a/g)?.length).toBe(21);
      expect(chunks.every((chunk) => chunk.trimEnd() !== `${marker}\n${marker}`)).toBe(true);
    },
  );
});

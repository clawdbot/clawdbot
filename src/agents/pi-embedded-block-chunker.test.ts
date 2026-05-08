import { describe, expect, it, vi } from "vitest";
import * as fences from "../markdown/fences.js";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";

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
  ).toEqual([]);
}

describe("EmbeddedBlockChunker", () => {
  it("breaks at paragraph boundary right after fence close", () => {
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

    expect(drainChunks(chunker)).toEqual([]);
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
    const chunker = new EmbeddedBlockChunker({
      minChars: 10,
      maxChars: 30,
      breakPreference: "paragraph",
    });

    chunker.append(`\`\`\`txt\n${"a".repeat(80)}\n\`\`\``);
    const chunks = drainChunks(chunker, true);

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.startsWith("```txt")).toBe(true);
      expect(chunk.match(/```/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(chunk).not.toContain("``\n```");
    }
  });
});

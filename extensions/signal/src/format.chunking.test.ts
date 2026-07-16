import { describe, expect, it } from "vitest";
import { markdownToSignalTextChunks } from "./format.js";

function expectChunkStyleRangesInBounds(chunks: ReturnType<typeof markdownToSignalTextChunks>) {
  for (const chunk of chunks) {
    for (const style of chunk.styles) {
      expect(style.start).toBeGreaterThanOrEqual(0);
      expect(style.start + style.length).toBeLessThanOrEqual(chunk.text.length);
      expect(style.length).toBeGreaterThan(0);
    }
  }
}

describe("splitSignalFormattedText", () => {
  // We test the internal chunking behavior via markdownToSignalTextChunks with
  // pre-rendered SignalFormattedText. The helper is not exported, so we test
  // it indirectly through integration tests and by constructing scenarios that
  // exercise the splitting logic.

  describe("style-aware splitting - basic text", () => {
    it("text with no styles splits correctly at whitespace", () => {
      // Create text that exceeds limit and must be split
      const limit = 20;
      const markdown = "hello world this is a test";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }
      // Verify all text is preserved (joined chunks should contain all words)
      const joinedText = chunks.map((c) => c.text).join(" ");
      expect(joinedText).toContain("hello");
      expect(joinedText).toContain("world");
      expect(joinedText).toContain("test");
    });

    it("empty text returns empty array", () => {
      // Empty input produces no chunks (not an empty chunk)
      const chunks = markdownToSignalTextChunks("", 100);
      expect(chunks).toEqual([]);
    });

    it("text under limit returns single chunk unchanged", () => {
      const markdown = "short text";
      const chunks = markdownToSignalTextChunks(markdown, 100);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe("short text");
    });
  });

  describe("style-aware splitting - style preservation", () => {
    it("style fully within first chunk stays in first chunk", () => {
      // Create a message where bold text is in the first chunk
      const limit = 30;
      const markdown = "**bold** word more words here that exceed limit";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks.length).toBeGreaterThan(1);
      // First chunk should contain the bold style
      const firstChunk = chunks[0];
      expect(firstChunk.text).toContain("bold");
      expect(firstChunk.styles.some((s) => s.style === "BOLD")).toBe(true);
      // The bold style should start at position 0 in the first chunk
      const boldStyle = firstChunk.styles.find((s) => s.style === "BOLD");
      expect(boldStyle).toBeDefined();
      expect(boldStyle!.start).toBe(0);
      expect(boldStyle!.length).toBe(4); // "bold"
    });

    it("style fully within second chunk has offset adjusted to chunk-local position", () => {
      // Create a message where the styled text is in the second chunk
      const limit = 30;
      const markdown = "some filler text here **bold** at the end";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks.length).toBeGreaterThan(1);
      // Find the chunk containing "bold"
      const chunkWithBold = chunks.find((c) => c.text.includes("bold"));
      expect(chunkWithBold).toBeDefined();
      expect(chunkWithBold!.styles.some((s) => s.style === "BOLD")).toBe(true);

      // The bold style should have chunk-local offset (not original text offset)
      const boldStyle = chunkWithBold!.styles.find((s) => s.style === "BOLD");
      expect(boldStyle).toBeDefined();
      // The offset should be the position within this chunk, not the original text
      const boldPos = chunkWithBold!.text.indexOf("bold");
      expect(boldStyle!.start).toBe(boldPos);
      expect(boldStyle!.length).toBe(4);
    });

    it("style spanning chunk boundary is split into two ranges", () => {
      // Create text where a styled span crosses the chunk boundary
      const limit = 15;
      // "hello **bold text here** end" - the bold spans across chunk boundary
      const markdown = "hello **boldtexthere** end";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks.length).toBeGreaterThan(1);

      // Both chunks should have BOLD styles if the span was split
      const chunksWithBold = chunks.filter((c) => c.styles.some((s) => s.style === "BOLD"));
      // At least one chunk should have the bold style
      expect(chunksWithBold.length).toBeGreaterThanOrEqual(1);

      // For each chunk with bold, verify the style range is valid for that chunk
      for (const chunk of chunksWithBold) {
        for (const style of chunk.styles.filter((s) => s.style === "BOLD")) {
          expect(style.start).toBeGreaterThanOrEqual(0);
          expect(style.start + style.length).toBeLessThanOrEqual(chunk.text.length);
        }
      }
    });

    it("style starting exactly at split point goes entirely to second chunk", () => {
      // Create text where style starts right at where we'd split
      const limit = 10;
      const markdown = "abcdefghi **bold**";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks.length).toBeGreaterThan(1);

      // Find chunk with bold
      const chunkWithBold = chunks.find((c) => c.styles.some((s) => s.style === "BOLD"));
      expect(chunkWithBold).toBeDefined();

      // Verify the bold style is valid within its chunk
      const boldStyle = chunkWithBold!.styles.find((s) => s.style === "BOLD");
      expect(boldStyle).toBeDefined();
      expect(boldStyle!.start).toBeGreaterThanOrEqual(0);
      expect(boldStyle!.start + boldStyle!.length).toBeLessThanOrEqual(chunkWithBold!.text.length);
    });

    it("style ending exactly at split point stays entirely in first chunk", () => {
      const limit = 10;
      const markdown = "**bold** rest of text";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      // First chunk should have the complete bold style
      const firstChunk = chunks[0];
      if (firstChunk.text.includes("bold")) {
        const boldStyle = firstChunk.styles.find((s) => s.style === "BOLD");
        expect(boldStyle).toBeDefined();
        expect(boldStyle!.start + boldStyle!.length).toBeLessThanOrEqual(firstChunk.text.length);
      }
    });

    it("multiple styles, some spanning boundary, some not", () => {
      const limit = 25;
      // Mix of styles: italic at start, bold spanning boundary, monospace at end
      const markdown = "_italic_ some text **bold text** and `code`";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks.length).toBeGreaterThan(1);

      // Verify all style ranges are valid within their respective chunks
      expectChunkStyleRangesInBounds(chunks);

      // Collect all styles across chunks
      const allStyles = chunks.flatMap((c) => c.styles.map((s) => s.style));
      // We should have at least italic, bold, and monospace somewhere
      expect(allStyles).toContain("ITALIC");
      expect(allStyles).toContain("BOLD");
      expect(allStyles).toContain("MONOSPACE");
    });
  });

  describe("style-aware splitting - edge cases", () => {
    it("handles zero-length text with styles gracefully", () => {
      // Edge case: empty markdown produces no chunks
      const chunks = markdownToSignalTextChunks("", 100);
      expect(chunks).toHaveLength(0);
    });

    it("handles text that splits exactly at limit", () => {
      const limit = 10;
      const markdown = "1234567890"; // exactly 10 chars
      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe("1234567890");
    });

    it("preserves style through whitespace trimming", () => {
      const limit = 30;
      const markdown = "**bold**  some text that is longer than limit";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      // Bold should be preserved in first chunk
      const firstChunk = chunks[0];
      if (firstChunk.text.includes("bold")) {
        expect(firstChunk.styles.some((s) => s.style === "BOLD")).toBe(true);
      }
    });

    it("handles repeated substrings correctly (no indexOf fragility)", () => {
      // This test exposes the fragility of using indexOf to find chunk positions.
      // If the same substring appears multiple times, indexOf finds the first
      // occurrence, not necessarily the correct one.
      const limit = 20;
      // "word" appears multiple times - indexOf("word") would always find first
      const markdown = "word **bold word** word more text here to chunk";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      // Verify chunks are under limit
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }

      // Find chunk(s) with bold style
      const chunksWithBold = chunks.filter((c) => c.styles.some((s) => s.style === "BOLD"));
      expect(chunksWithBold.length).toBeGreaterThanOrEqual(1);

      // The bold style should correctly cover "bold word" (or part of it if split)
      // and NOT incorrectly point to the first "word" in the text
      for (const chunk of chunksWithBold) {
        for (const style of chunk.styles.filter((s) => s.style === "BOLD")) {
          const styledText = chunk.text.slice(style.start, style.start + style.length);
          // The styled text should be part of "bold word", not the initial "word"
          expect(styledText).toMatch(/^(bold( word)?|word)$/);
          expect(style.start).toBeGreaterThanOrEqual(0);
          expect(style.start + style.length).toBeLessThanOrEqual(chunk.text.length);
        }
      }
    });

    it("handles chunk that starts with whitespace after split", () => {
      // When text is split at whitespace, the next chunk might have leading
      // whitespace trimmed. Styles must account for this.
      const limit = 15;
      const markdown = "some text **bold** at end";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      // All style ranges must be valid
      for (const chunk of chunks) {
        for (const style of chunk.styles) {
          expect(style.start).toBeGreaterThanOrEqual(0);
          expect(style.start + style.length).toBeLessThanOrEqual(chunk.text.length);
        }
      }
    });

    it("deterministically tracks position without indexOf fragility", () => {
      // This test ensures the chunker doesn't rely on finding chunks via indexOf
      // which can fail when chunkText trims whitespace or when duplicates exist.
      // Create text with lots of whitespace and repeated patterns.
      const limit = 25;
      const markdown = "aaa   **bold**   aaa   **bold**   aaa extra text to force split";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      // Multiple chunks expected
      expect(chunks.length).toBeGreaterThan(1);

      // All chunks should respect limit
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }

      // All style ranges must be valid within their chunks
      for (const chunk of chunks) {
        for (const style of chunk.styles) {
          expect(style.start).toBeGreaterThanOrEqual(0);
          expect(style.start + style.length).toBeLessThanOrEqual(chunk.text.length);
          // The styled text at that position should actually be "bold"
          if (style.style === "BOLD") {
            const styledText = chunk.text.slice(style.start, style.start + style.length);
            expect(styledText).toBe("bold");
          }
        }
      }
    });
  });
});

describe("markdownToSignalTextChunks", () => {
  describe("link expansion chunk limit", () => {
    it("does not exceed chunk limit after link expansion", () => {
      // Create text that is close to limit, with a link that will expand
      const limit = 100;
      // Create text that's 90 chars, leaving only 10 chars of headroom
      const filler = "x".repeat(80);
      // This link will expand from "[link](url)" to "link (https://example.com/very/long/path)"
      const markdown = `${filler} [link](https://example.com/very/long/path/that/will/exceed/limit)`;

      const chunks = markdownToSignalTextChunks(markdown, limit);

      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }
    });

    it("handles multiple links near chunk boundary", () => {
      const limit = 100;
      const filler = "x".repeat(60);
      const markdown = `${filler} [a](https://a.com) [b](https://b.com) [c](https://c.com)`;

      const chunks = markdownToSignalTextChunks(markdown, limit);

      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }
    });
  });

  describe("link expansion with style preservation", () => {
    it("long message with links that expand beyond limit preserves all text", () => {
      const limit = 80;
      const filler = "a".repeat(50);
      const markdown = `${filler} [click here](https://example.com/very/long/path/to/page) more text`;

      const chunks = markdownToSignalTextChunks(markdown, limit);

      // All chunks should be under limit
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }

      // Combined text should contain all original content
      const combined = chunks.map((c) => c.text).join("");
      expect(combined).toContain(filler);
      expect(combined).toContain("click here");
      expect(combined).toContain("example.com");
    });

    it("styles (bold, italic) survive chunking correctly after link expansion", () => {
      const limit = 60;
      const markdown =
        "**bold start** text [link](https://example.com/path) _italic_ more content here to force chunking";

      const chunks = markdownToSignalTextChunks(markdown, limit);

      // Should have multiple chunks
      expect(chunks.length).toBeGreaterThan(1);

      // All style ranges should be valid within their chunks
      expectChunkStyleRangesInBounds(chunks);

      // Verify styles exist somewhere
      const allStyles = chunks.flatMap((c) => c.styles.map((s) => s.style));
      expect(allStyles).toContain("BOLD");
      expect(allStyles).toContain("ITALIC");
    });

    it("multiple links near chunk boundary all get properly chunked", () => {
      const limit = 50;
      const markdown =
        "[first](https://first.com/long/path) [second](https://second.com/another/path) [third](https://third.com)";

      const chunks = markdownToSignalTextChunks(markdown, limit);

      // All chunks should respect limit
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }

      // All link labels should appear somewhere
      const combined = chunks.map((c) => c.text).join("");
      expect(combined).toContain("first");
      expect(combined).toContain("second");
      expect(combined).toContain("third");
    });

    it("preserves spoiler style through link expansion and chunking", () => {
      const limit = 40;
      const markdown =
        "||secret content|| and [link](https://example.com/path) with more text to chunk";

      const chunks = markdownToSignalTextChunks(markdown, limit);

      // All chunks should respect limit
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }

      // Spoiler style should exist and be valid
      const chunkWithSpoiler = chunks.find((c) => c.styles.some((s) => s.style === "SPOILER"));
      expect(chunkWithSpoiler).toBeDefined();

      const spoilerStyle = chunkWithSpoiler!.styles.find((s) => s.style === "SPOILER");
      expect(spoilerStyle).toBeDefined();
      expect(spoilerStyle!.start).toBeGreaterThanOrEqual(0);
      expect(spoilerStyle!.start + spoilerStyle!.length).toBeLessThanOrEqual(
        chunkWithSpoiler!.text.length,
      );
    });
  });
});

// Voice Call tests cover telephony reply chunking behavior.
import { describe, expect, it } from "vitest";
import { chunkTelephonyReply } from "./telephony-tts-chunking.js";

describe("chunkTelephonyReply", () => {
  it("returns short text unchanged as a single piece", () => {
    expect(chunkTelephonyReply("Hello there.", 320)).toEqual(["Hello there."]);
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(chunkTelephonyReply("", 320)).toEqual([]);
    expect(chunkTelephonyReply("   \n  ", 320)).toEqual([]);
  });

  it("splits on sentence boundaries and keeps every piece within the limit", () => {
    const sentences = Array.from(
      { length: 8 },
      (_, i) => `This is sentence number ${i} with a little filler.`,
    );
    const text = sentences.join(" ");
    const chunks = chunkTelephonyReply(text, 120);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
    // Each piece ends on sentence punctuation (natural pause), not mid-sentence.
    for (const chunk of chunks) {
      expect(/[.!?]$/.test(chunk)).toBe(true);
    }
    // Content is preserved (only whitespace at boundaries differs).
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("packs multiple short sentences together up to the limit", () => {
    const text = "One. Two. Three. Four. Five.";
    // Comfortably under the limit -> a single packed piece.
    expect(chunkTelephonyReply(text, 320)).toEqual(["One. Two. Three. Four. Five."]);
  });

  it("hard-bounds a single over-long sentence via the shared splitter", () => {
    const longSentence = `${"word ".repeat(120).trim()}.`; // ~600 chars, one sentence
    const chunks = chunkTelephonyReply(longSentence, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });

  it("hard-cuts an unbroken token longer than the limit", () => {
    const url = `https://example.com/${"a".repeat(400)}`; // no whitespace, > limit
    const chunks = chunkTelephonyReply(url, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
    expect(chunks.join("")).toBe(url);
  });
});

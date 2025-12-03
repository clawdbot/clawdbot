import { describe, expect, it } from "vitest";

import { chunkText } from "./chunk.js";

describe("chunkText", () => {
  it("keeps multi-line text in one chunk when under limit", () => {
    const text = "Line one\n\nLine two\n\nLine three";
    const chunks = chunkText(text, 1600);
    expect(chunks).toEqual([text]);
  });

  it("splits only when text exceeds the limit", () => {
    const part = "a".repeat(20);
    const text = part.repeat(5); // 100 chars
    const chunks = chunkText(text, 60);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(60);
    expect(chunks[1].length).toBe(40);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers breaking at a newline before the limit", () => {
    const text = `paragraph one line\n\nparagraph two starts here and continues`;
    const chunks = chunkText(text, 40);
    expect(chunks).toEqual([
      "paragraph one line",
      "paragraph two starts here and continues",
    ]);
  });

  it("otherwise breaks at the last whitespace under the limit", () => {
    const text =
      "This is a message that should break nicely near a word boundary.";
    const chunks = chunkText(text, 30);
    expect(chunks[0].length).toBeLessThanOrEqual(30);
    expect(chunks[1].length).toBeLessThanOrEqual(30);
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(
      text.replace(/\s+/g, " ").trim(),
    );
  });

  it("falls back to a hard break when no whitespace is present", () => {
    const text = "Supercalifragilisticexpialidocious"; // 34 chars
    const chunks = chunkText(text, 10);
    expect(chunks).toEqual(["Supercalif", "ragilistic", "expialidoc", "ious"]);
  });
});

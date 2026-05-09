import { describe, expect, it } from "vitest";
import { extractMarkdownFormatRuns } from "./markdown-format.js";

describe("extractMarkdownFormatRuns", () => {
  it("returns the text unchanged when there is no markdown", () => {
    const { text, ranges } = extractMarkdownFormatRuns("plain text reply");
    expect(text).toBe("plain text reply");
    expect(ranges).toStrictEqual([]);
  });

  it("extracts a bold span", () => {
    const { text, ranges } = extractMarkdownFormatRuns("**bold** text");
    expect(text).toBe("bold text");
    expect(ranges).toEqual([{ start: 0, length: 4, styles: ["bold"] }]);
  });

  it("extracts mixed bold and italic", () => {
    const { text, ranges } = extractMarkdownFormatRuns("**hi** and *there*");
    expect(text).toBe("hi and there");
    expect(ranges).toEqual([
      { start: 0, length: 2, styles: ["bold"] },
      { start: 7, length: 5, styles: ["italic"] },
    ]);
  });

  it("extracts underline and strikethrough", () => {
    const { text, ranges } = extractMarkdownFormatRuns("__under__ and ~~strike~~");
    expect(text).toBe("under and strike");
    expect(ranges).toEqual([
      { start: 0, length: 5, styles: ["underline"] },
      { start: 10, length: 6, styles: ["strikethrough"] },
    ]);
  });

  it("respects word boundaries on single-underscore italics", () => {
    const { text, ranges } = extractMarkdownFormatRuns("snake_case_var ok");
    expect(text).toBe("snake_case_var ok");
    expect(ranges).toStrictEqual([]);
  });

  it("treats single-underscore as italic when surrounded by whitespace", () => {
    const { text, ranges } = extractMarkdownFormatRuns("a _word_ b");
    expect(text).toBe("a word b");
    expect(ranges).toEqual([{ start: 2, length: 4, styles: ["italic"] }]);
  });

  it("does not treat empty marker pairs as formatting", () => {
    const { text, ranges } = extractMarkdownFormatRuns("**  ** literal");
    expect(text).toBe("**  ** literal");
    expect(ranges).toStrictEqual([]);
  });

  it("leaves a lone asterisk alone", () => {
    const { text, ranges } = extractMarkdownFormatRuns("price * quantity");
    expect(text).toBe("price * quantity");
    expect(ranges).toStrictEqual([]);
  });

  it("computes ranges in output coordinates, not input", () => {
    const { text, ranges } = extractMarkdownFormatRuns("a **b** c **d** e");
    expect(text).toBe("a b c d e");
    expect(ranges).toEqual([
      { start: 2, length: 1, styles: ["bold"] },
      { start: 6, length: 1, styles: ["bold"] },
    ]);
  });

  it("parses ***triple-marker*** as bold + italic over the same span", () => {
    const { text, ranges } = extractMarkdownFormatRuns("***hi***");
    expect(text).toBe("hi");
    // Compound marker emits both styles over the same span.
    expect(ranges).toEqual([
      { start: 0, length: 2, styles: ["bold"] },
      { start: 0, length: 2, styles: ["italic"] },
    ]);
  });

  it("parses **bold _and underline_ together** as nested ranges", () => {
    const { text, ranges } = extractMarkdownFormatRuns("**bold _and underline_ together**");
    expect(text).toBe("bold and underline together");
    // Inner italic-via-_ at offset 5, length 13; outer bold over the full span.
    expect(ranges).toEqual([
      { start: 5, length: 13, styles: ["italic"] },
      { start: 0, length: 27, styles: ["bold"] },
    ]);
  });

  it("respects word boundaries on double-underscore underline", () => {
    const { text, ranges } = extractMarkdownFormatRuns("def __init__(self):");
    expect(text).toBe("def __init__(self):");
    expect(ranges).toStrictEqual([]);
  });

  it("does not leak literal asterisks from triple markers when intent is unclear", () => {
    // `***bold***` should never produce a bare `*` in the output text.
    const { text } = extractMarkdownFormatRuns("hello ***world***");
    expect(text).not.toMatch(/\*/);
  });
});

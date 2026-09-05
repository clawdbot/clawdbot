import { describe, expect, it } from "vitest";
import { startsWithSvgRootElement } from "./http-image-response.js";

describe("startsWithSvgRootElement", () => {
  it.each([
    ["a bare root element", "<svg></svg>"],
    ["a self-closing root element", "<svg/>"],
    ["leading whitespace", "\n\t <svg >"],
    ["an XML declaration", '<?xml version="1.0"?><svg>'],
    ["an uppercase root element", "<SVG>"],
    ["a leading comment", "<!-- icon --><svg>"],
    ["several leading comments", "<!-- a --> <!-- b --><svg>"],
  ])("accepts %s", (_label, text) => {
    expect(startsWithSvgRootElement(text)).toBe(true);
  });

  it.each([
    ["a non-SVG root element", "<html><svg></svg></html>"],
    ["a root-like prefix", "<svgx>"],
    ["an incomplete self-closing root element", "<svg/"],
    ["an unterminated XML declaration", '<?xml version="1.0"'],
    ["an unterminated comment", "<!-- never closed <svg>"],
    ["markup between a comment and the root element", "<!-- a --> junk <svg>"],
    // A comment ends at its first `-->`; the replaced pattern instead let one
    // comment absorb this text, so keep the stricter reading pinned.
    ["markup between two comments", "<!-- a --> junk <!-- b --><svg>"],
    ["no root element at all", "not markup"],
  ])("rejects %s", (_label, text) => {
    expect(startsWithSvgRootElement(text)).toBe(false);
  });
});

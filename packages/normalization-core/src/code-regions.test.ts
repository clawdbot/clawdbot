import { describe, expect, it } from "vitest";
import { findCodeRegions, type CodeRegion } from "./code-regions.js";

/** Slices each discovered region out of the source so tests assert exact spans. */
function regionText(text: string, regions: CodeRegion[]): string[] {
  return regions.map((region) => text.slice(region.start, region.end));
}

describe("findCodeRegions", () => {
  it("detects a fenced block spanning the fence markers", () => {
    const text = ["before", "```ts", "const x = 1;", "```", "after"].join("\n");
    expect(regionText(text, findCodeRegions(text))).toEqual([
      ["```ts", "const x = 1;", "```"].join("\n"),
    ]);
  });

  it("detects an inline backtick span", () => {
    const text = "call `findCodeRegions()` here";
    expect(regionText(text, findCodeRegions(text))).toEqual(["`findCodeRegions()`"]);
  });

  it("treats a 4-space indented line at document start as a region", () => {
    const text = "    literal";
    expect(regionText(text, findCodeRegions(text))).toEqual(["    literal"]);
  });

  it("treats an indented block after a blank line as a region and keeps prose out", () => {
    const text = ["prose paragraph", "", "    indented code"].join("\n");
    expect(regionText(text, findCodeRegions(text))).toEqual(["    indented code"]);
  });

  it("does not treat a paragraph-continuation indented line as a region", () => {
    // A 4-space line directly following prose is a lazy paragraph continuation,
    // not an indented code block, so a leaked call there stays scrubbable.
    const text = ["paragraph text", "    still same paragraph"].join("\n");
    expect(findCodeRegions(text)).toEqual([]);
  });

  it("treats a single leading tab as a 4-column indented region", () => {
    const text = "\tliteral";
    expect(regionText(text, findCodeRegions(text))).toEqual(["\tliteral"]);
  });

  it("keeps interior blank lines and excludes trailing blank lines", () => {
    const text = ["    a", "", "    b", "", "tail"].join("\n");
    expect(regionText(text, findCodeRegions(text))).toEqual([["    a", "", "    b"].join("\n")]);
  });

  it("does not double-count indented content against fenced or inline spans", () => {
    const text = ["`<inline>`", "", "```html", "<block>", "```", "", "    <indented>"].join("\n");
    const regions = findCodeRegions(text);
    expect(regionText(text, regions)).toEqual([
      "`<inline>`",
      ["```html", "<block>", "```"].join("\n"),
      "    <indented>",
    ]);
    // Regions are non-overlapping and sorted by start.
    for (let index = 1; index < regions.length; index += 1) {
      expect(regions[index]!.start).toBeGreaterThanOrEqual(regions[index - 1]!.end);
    }
  });
});

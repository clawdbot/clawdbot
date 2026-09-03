import { describe, expect, it } from "vitest";
import { resolveHttpImageRepresentation, startsWithSvgRootElement } from "./http-image-response.js";

// A closed comment ends at its first `-->`, so this is comment-like markup that
// never reaches a root element. The pattern this scanner replaced explored every
// way of splitting the repeats and took exponential time on exactly this shape.
function buildUnterminatedCommentRun(repeats: number): string {
  return `<!--${"--><!--".repeat(repeats)}-->X`;
}

describe("startsWithSvgRootElement", () => {
  it.each([
    ["a bare root element", "<svg></svg>"],
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
    ["a root element with no delimiter", "<svg/>"],
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

  it("rejects a comment run in linear time instead of backtracking", () => {
    const started = process.hrtime.bigint();
    expect(startsWithSvgRootElement(buildUnterminatedCommentRun(64))).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(100);
  });
});

describe("resolveHttpImageRepresentation", () => {
  it("rejects a comment-run SVG body without stalling the event loop", async () => {
    const started = process.hrtime.bigint();
    await expect(
      resolveHttpImageRepresentation("icon.svg", Buffer.from(buildUnterminatedCommentRun(64))),
    ).resolves.toBeUndefined();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("still serves a valid SVG body", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    await expect(
      resolveHttpImageRepresentation("icon.svg", Buffer.from(svg)),
    ).resolves.toMatchObject({ contentType: "image/svg+xml" });
  });
});

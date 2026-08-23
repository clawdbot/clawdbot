import { describe, expect, it } from "vitest";
import { chunkSessionContentAtResetBoundary } from "./manager-reset-chunk-boundary.js";

describe("chunkSessionContentAtResetBoundary", () => {
  it("never overlaps a pre-reset chunk into the current generation", () => {
    const chunks = chunkSessionContentAtResetBoundary({
      content: "old one\nold two\nkept live\ncurrent turn",
      cutoffLine: 7,
      lineMap: [2, 4, 7, 9],
      chunking: { tokens: 100, overlap: 50 },
    });

    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine, chunk.text])).toEqual([
      [1, 2, "old one\nold two"],
      [3, 4, "kept live\ncurrent turn"],
    ]);
  });
});

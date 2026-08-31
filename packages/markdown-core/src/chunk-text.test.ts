// Markdown Core tests cover plain-text chunking behavior.
import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk-text.js";

describe("chunkText", () => {
  it("normalizes positive fractional limits without emitting empty chunks", () => {
    expect(chunkText("abc", 0.5)).toEqual(["a", "b", "c"]);
    expect(chunkText("😀😀", 0.5)).toEqual(["😀", "😀"]);
  });
});

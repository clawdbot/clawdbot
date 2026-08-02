import { describe, expect, it } from "vitest";
import { chunkTextForOutbound } from "./runtime-api.js";

describe("Matrix runtime API", () => {
  it("delegates fractional chunk limits to the progress-safe SDK owner", () => {
    expect(chunkTextForOutbound("ABCD", 0.5)).toEqual(["A", "B", "C", "D"]);
    expect(chunkTextForOutbound("😀😀", 1.5)).toEqual(["😀", "😀"]);
  });

  it("preserves Matrix compatibility behavior for non-fractional limits", () => {
    expect(chunkTextForOutbound("", 5)).toEqual([""]);
    expect(chunkTextForOutbound("abcdef   ", 5)).toEqual(["abcde", "f   "]);
  });
});

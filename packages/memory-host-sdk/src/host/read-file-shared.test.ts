// Memory Host SDK tests cover read file shared behavior.
import { describe, expect, it } from "vitest";
import { buildMemoryReadResult, buildMemoryReadResultFromSlice } from "./read-file-shared.js";

describe("memory read result slicing", () => {
  it("uses default line windows for non-finite from and lines values", () => {
    expect(
      buildMemoryReadResult({
        content: "one\ntwo\nthree",
        relPath: "memory/test.md",
        from: Number.NaN,
        lines: Number.NaN,
      }),
    ).toEqual({
      text: "one\ntwo\nthree",
      path: "memory/test.md",
      from: 1,
      lines: 3,
    });
  });

  it("uses the default character budget for non-finite maxChars values", () => {
    expect(
      buildMemoryReadResultFromSlice({
        selectedLines: ["one", "two"],
        relPath: "memory/test.md",
        startLine: Number.POSITIVE_INFINITY,
        maxChars: Number.NaN,
      }),
    ).toEqual({
      text: "one\ntwo",
      path: "memory/test.md",
      from: 1,
      lines: 2,
    });
  });
});

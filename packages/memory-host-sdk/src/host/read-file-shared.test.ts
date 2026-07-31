// Memory Host SDK tests cover read file shared behavior.
import { describe, expect, it } from "vitest";
import { buildMemoryReadResult, buildMemoryReadResultFromSlice } from "./read-file-shared.js";

describe("memory read result slicing", () => {
  it.each([
    {
      name: "a terminal newline",
      content: "one\ntwo\n",
      requestedLines: 2,
      text: "one\ntwo",
      lines: 2,
    },
    {
      name: "an empty file",
      content: "",
      requestedLines: 2,
      text: "",
      lines: 0,
    },
    {
      name: "one intentional trailing blank line",
      content: "one\n\n",
      requestedLines: 2,
      text: "one\n",
      lines: 2,
    },
    {
      name: "two intentional trailing blank lines",
      content: "one\n\n\n",
      requestedLines: 3,
      text: "one\n\n",
      lines: 3,
    },
  ])("does not expose a phantom continuation for $name", (fixture) => {
    expect(
      buildMemoryReadResult({
        content: fixture.content,
        relPath: "memory/test.md",
        lines: fixture.requestedLines,
      }),
    ).toEqual({
      text: fixture.text,
      path: "memory/test.md",
      from: 1,
      lines: fixture.lines,
    });
  });

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

  it("does not split surrogate pairs when truncating a single line", () => {
    expect(
      buildMemoryReadResultFromSlice({
        selectedLines: ["abc🤖tail"],
        relPath: "memory/test.md",
        startLine: 1,
        maxChars: 4,
        suggestReadFallback: true,
      }),
    ).toEqual({
      text: "abc\n\n[More content available. Requested excerpt exceeded the default maxChars budget. If you need the full raw line, use read on the source file.]",
      path: "memory/test.md",
      from: 1,
      lines: 1,
      truncated: true,
    });
  });

  it("keeps the continuation notice when a leading surrogate pair is dropped", () => {
    expect(
      buildMemoryReadResultFromSlice({
        selectedLines: ["🤖tail"],
        relPath: "memory/test.md",
        startLine: 1,
        maxChars: 1,
        suggestReadFallback: true,
      }),
    ).toEqual({
      text: "\n\n[More content available. Requested excerpt exceeded the default maxChars budget. If you need the full raw line, use read on the source file.]",
      path: "memory/test.md",
      from: 1,
      lines: 1,
      truncated: true,
    });
  });
});

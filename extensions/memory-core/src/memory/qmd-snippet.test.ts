import { describe, expect, it } from "vitest";
import { parseQmdSnippet } from "./qmd-snippet.js";

describe("parseQmdSnippet", () => {
  it.each([
    ["cli", "\uFEFF@@ -2,1 @@ (1 before, 3 after)\r\ncontent\r\n", "content\r\n", 2, 2],
    [
      "mcp",
      "11: @@ -10,4 @@ (9 before, 0 after)\n12: first\n13:\n14: 12: document prose\n",
      "first\n\n12: document prose\n",
      10,
      13,
    ],
    ["mcp", "11: @@ -10,2\n12: first\n14: second", "12: first\n14: second", 10, 11],
    ["cli", "@@ -1,2\n@@ -8,1\nreal", "@@ -8,1\nreal", 1, 2],
    ["mcp", "@@ -7,1\ncontent", "@@ -7,1\ncontent", 0, 0],
    ["cli", "prefix\n@@ -7,1\ncontent", "prefix\n@@ -7,1\ncontent", 0, 0],
    [
      "mcp",
      "11: @@ -10,1 @@ trailing junk\n12: content",
      "11: @@ -10,1 @@ trailing junk\n12: content",
      0,
      0,
    ],
  ] as const)("handles %s envelopes", (transport, raw, snippet, startLine, endLine) => {
    const expected = startLine ? { snippet, startLine, endLine } : { snippet };
    expect(parseQmdSnippet(raw, transport, 1000)).toEqual(expected);
  });

  it("retains the configured MCP cap after stripping line prefixes", () => {
    const body = Array.from({ length: 6000 }, (_, index) => `${index + 2}: x`).join("\n");
    expect(parseQmdSnippet(`1: @@ -1,6000\n${body}`, "mcp", 5000).snippet).toBe("x\n".repeat(2500));
  });
});

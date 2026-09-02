import { describe, expect, it } from "vitest";
import { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";

describe("sanitizeUserFacingText duplicate-block collapse", () => {
  it("keeps fenced code byte-for-byte when duplicate collapsing fires nearby", () => {
    const reply = [
      "Here is the retry loop and the log it produced:",
      "",
      "```python",
      "class Worker:",
      "    def run(self):",
      '        self.log("retrying")',
      "",
      "    def log(self, msg):",
      "        print(msg)",
      "```",
      "",
      "```text",
      "[worker] retrying",
      "",
      "[worker] retrying",
      "",
      "[worker] retrying",
      "",
      "[worker] done",
      "```",
    ].join("\n");
    expect(sanitizeUserFacingText(reply)).toBe(reply);
  });

  it.each([
    {
      name: "collapses adjacent duplicate prose",
      input: "intro\n\nrepeat\n\nrepeat\n\ncoda",
      expected: "intro\n\nrepeat\n\ncoda",
    },
    {
      name: "resets duplicate comparison around fenced code",
      input: "note\n\n```python\n    keep_indent()\n```\n\nnote",
      expected: "note\n\n```python\n    keep_indent()\n```\n\nnote",
    },
    {
      name: "collapses duplicate prose after fenced code",
      input: "note\n\n```python\n    keep_indent()\n```\n\nmore\n\nmore",
      expected: "note\n\n```python\n    keep_indent()\n```\n\nmore",
    },
    {
      name: "keeps an initial indented code block byte-for-byte",
      input: "    first\n\n    second\n\ntail\n\ntail",
      expected: "    first\n\n    second\n\ntail",
    },
    {
      name: "resets duplicate comparison around indented code",
      input: "repeat\n\n    repeat\n\nrepeat",
      expected: "repeat\n\n    repeat\n\nrepeat",
    },
    {
      name: "does not compare the prose before inline code as a complete block",
      input: "repeat\n\nrepeat `x`",
      expected: "repeat\n\nrepeat `x`",
    },
    {
      name: "does not compare the prose after inline code as a complete block",
      input: "Do `x` repeat\n\nrepeat",
      expected: "Do `x` repeat\n\nrepeat",
    },
    {
      name: "keeps leading prose trimming when a duplicate is removed",
      input: "  A\n\nA",
      expected: "A",
    },
    {
      name: "keeps trailing prose trimming when a duplicate is removed",
      input: "A\n\nA\n\n",
      expected: "A",
    },
  ])("$name", ({ input, expected }) => {
    expect(sanitizeUserFacingText(input)).toBe(expected);
  });
});

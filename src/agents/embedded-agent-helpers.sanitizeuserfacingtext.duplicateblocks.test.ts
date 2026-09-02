/**
 * Regression coverage for duplicate-block collapse in user-facing sanitization:
 * fenced code must survive byte-for-byte while prose de-duplication still works.
 */

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
    // Blank lines inside fences split the reply into whitespace-equal chunks; the
    // sanitizer must not delete or re-trim them because code is whitespace-sensitive.
    expect(sanitizeUserFacingText(reply)).toBe(reply);
  });

  it("still collapses duplicate prose blocks and preserves code while doing so", () => {
    expect(sanitizeUserFacingText("A\n\nA")).toBe("A");
    expect(sanitizeUserFacingText("intro\n\nrepeat\n\nrepeat\n\ncoda")).toBe(
      "intro\n\nrepeat\n\ncoda",
    );
    // Adjacent-only comparison: prose around a fence keeps its repeats, the fence keeps its bytes.
    expect(sanitizeUserFacingText("note\n\n```python\n    keep_indent()\n```\n\nnote")).toBe(
      "note\n\n```python\n    keep_indent()\n```\n\nnote",
    );
    expect(
      sanitizeUserFacingText("note\n\n```python\n    keep_indent()\n```\n\nmore\n\nmore"),
    ).toBe("note\n\n```python\n    keep_indent()\n```\n\nmore");
  });

  it("keeps an initial indented code block byte-for-byte", () => {
    const reply = "    first\n\n    second\n\ntail\n\ntail";
    // Leading indentation makes the first two chunks one indented code block;
    // discovering regions after trimming would hide it from the parser and
    // re-emit `first` as de-indented prose.
    expect(sanitizeUserFacingText(reply)).toBe("    first\n\n    second\n\ntail");
  });

  it("ends the duplicate sequence at a protected code block", () => {
    // Prose after an intervening protected block never compares across it, so
    // the final `repeat` survives even though its text matches the first block.
    expect(sanitizeUserFacingText("repeat\n\n    repeat\n\nrepeat")).toBe(
      "repeat\n\n    repeat\n\nrepeat",
    );
  });
});

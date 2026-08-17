import { describe, expect, it } from "vitest";
import { stripFormattedReasoningMessage } from "./formatted-reasoning-message.js";

describe("stripFormattedReasoningMessage", () => {
  it("preserves leading whitespace in the substantive answer body", () => {
    const input = ["Thinking...", "_brief summary_", "", "    const value = 1;"].join("\n");

    expect(stripFormattedReasoningMessage(input)).toBe("    const value = 1;");
  });

  it("preserves a multi-line indented code block after a Thinking preamble", () => {
    const input = [
      "Thinking...",
      "_summary_",
      "",
      "    function foo() {",
      "      return 1;",
      "    }",
    ].join("\n");

    expect(stripFormattedReasoningMessage(input)).toBe(
      "    function foo() {\n      return 1;\n    }",
    );
  });

  it("strips a 'Reasoning:' preamble and preserves the body exactly", () => {
    const input = ["Reasoning:", "_summary_", "", "Answer here"].join("\n");

    expect(stripFormattedReasoningMessage(input)).toBe("Answer here");
  });

  it("returns text unchanged when the first line is not a known preamble", () => {
    const input = "Just a normal answer with no preamble.";

    expect(stripFormattedReasoningMessage(input)).toBe(input);
  });

  it("returns text unchanged when a Thinking preamble lacks the italic summary", () => {
    // Thinking... without the following _italic summary_ is not a formatted
    // preamble, so the whole text is returned as-is.
    const input = ["Thinking...", "    const value = 1;"].join("\n");

    expect(stripFormattedReasoningMessage(input)).toBe(input);
  });

  it("strips trailing blank lines while preserving leading whitespace in the body", () => {
    const input = ["Thinking...", "_summary_", "", "body", ""].join("\n");

    expect(stripFormattedReasoningMessage(input)).toBe("body");
  });
});

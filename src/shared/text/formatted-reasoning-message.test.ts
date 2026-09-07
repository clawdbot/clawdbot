import { describe, expect, it } from "vitest";
import { stripFormattedReasoningMessage } from "./formatted-reasoning-message.js";

describe("stripFormattedReasoningMessage", () => {
  it.each([
    "  Ordinary😀\r\n  visible text \r\n",
    "Thinking...\r\n  I'll check now\r\n_visible_ \r\n",
    "Thinking\r\n \t\r\n",
    "Thinking\n_\nVisible",
    "Thinking....\n_summary_\nVisible",
    "Thinking…\n_summary_\nVisible",
    "\nThinking\n_summary_\nVisible",
    "Thinking\r_summary_\rVisible",
    "Thinking\u2028_summary_\nVisible",
  ])("preserves non-preamble text byte for byte: %j", (input) => {
    expect(stripFormattedReasoningMessage(input)).toBe(input);
  });

  it.each(["Reasoning:", "Thinking", "Thinking.", "Thinking..", "Thinking..."])(
    "removes only the %s preamble and normalizes answer line endings",
    (header) => {
      const input = `\u00a0${header} \t\r\n\r\n _summary_ \r\n_more_\r\n Answer😀\r\r\n_keep this_\r\nlast \r\n`;
      expect(stripFormattedReasoningMessage(input)).toBe(" Answer😀\r\n_keep this_\nlast ");
    },
  );

  it.each([
    ["Reasoning:\r\n \r\nVisible", "Visible"],
    ["Reasoning:", ""],
    ["Thinking\n__", ""],
    ["<think>private</think>Thinking\n_summary_\nVisible", "Visible"],
    ["Normal\n<internal>private</internal>\nanswer", "Normal\n\nanswer"],
    ["<thinking>outer<internal>private", ""],
    ["Use `<think>literal</think>` exactly.", "Use `<think>literal</think>` exactly."],
  ])("keeps tag privacy and distinct header rules: %j", (input, expected) => {
    expect(stripFormattedReasoningMessage(input)).toBe(expected);
  });
  it.each([
    ["<think>private</think>    const value = 1;", "    const value = 1;"],
    ["<final>    const value = 1;</final>", "    const value = 1;"],
    ["<think>private</think> \n\t ", ""],
    [
      "\nThinking\n_summary_\nUse `<think>literal</think>` exactly.",
      "\nThinking\n_summary_\nUse `<think>literal</think>` exactly.",
    ],
    ["Thinking...\n_summary_\n\n    const value = 1;", "    const value = 1;"],
    ["Reasoning:\n_summary_\n\tconst value = 1;", "\tconst value = 1;"],
    ["<think>private</think>\nThinking\n_summary_\n    const value = 1;", "    const value = 1;"],
    [
      "Thinking\n_summary_\n\n    first line\n      second line\n\n",
      "    first line\n      second line",
    ],
  ])("preserves substantive code indentation after a preamble: %j", (input, expected) => {
    expect(stripFormattedReasoningMessage(input)).toBe(expected);
  });
});

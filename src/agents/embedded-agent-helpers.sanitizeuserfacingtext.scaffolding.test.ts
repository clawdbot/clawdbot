import { describe, expect, it } from "vitest";
import { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";

describe("user-facing internal scaffolding", () => {
  const conversationContext = [
    "[Chat messages since your last reply - for context]",
    "Alice: private history",
    "",
    "[Current message - respond to this]",
    "private inbound paragraph",
  ].join("\n");

  it.each([
    { name: "same-line prefix", input: `LEAK:${conversationContext}`, expected: "LEAK:" },
    {
      name: "same-line suffix",
      input: `${conversationContext} Visible answer.`,
      expected: " Visible answer.",
    },
    {
      name: "same-line wrapper",
      input: `Before ${conversationContext} after`,
      expected: "Before  after",
    },
  ])("removes exact copied prompts with a $name", ({ input, expected }) => {
    expect(sanitizeUserFacingText(input, { conversationContext })).toBe(expected);
  });

  it.each([
    {
      name: "Markdown fence",
      input: `Visible answer.\n\n\`\`\`text\n${conversationContext}\n\`\`\``,
    },
    { name: "Markdown quote", input: `Visible answer.\n\n> ${conversationContext}` },
    {
      name: "multiline Markdown quote",
      input: `Visible answer.\n\n${conversationContext
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`,
    },
    {
      name: "indented Markdown block",
      input: `Visible answer.\n\n${conversationContext
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")}`,
    },
    {
      name: "Markdown list",
      input: `Visible answer.\n\n${conversationContext
        .split("\n")
        .map((line) => `- ${line}`)
        .join("\n")}`,
    },
    {
      name: "Markdown headings",
      input: `Visible answer.\n\n${conversationContext
        .split("\n")
        .map((line) => `# ${line}`)
        .join("\n")}`,
    },
    {
      name: "multiline Markdown list item",
      input: `Visible answer.\n\n${conversationContext
        .split("\n")
        .map((line, index) => `${index === 0 ? "- " : "  "}${line}`)
        .join("\n")}`,
    },
    {
      name: "bare carriage-return line endings",
      input: `Visible answer.\n\n${conversationContext.replace(/\n/g, "\r")}`,
    },
  ])("never preserves an exact private prompt inside a $name", ({ input }) => {
    const result = sanitizeUserFacingText(input, { conversationContext });

    expect(result).toContain("Visible answer.");
    expect(result).not.toContain("Alice: private history");
    expect(result).not.toContain("private inbound paragraph");
  });

  it.each([
    { input: "(no output)", expected: "" },
    { input: "  (no output)\r\n", expected: "" },
    { input: "Visible\n(no output)\nanswer", expected: "Visible\nanswer" },
    {
      input: "The literal (no output) is intentional.",
      expected: "The literal (no output) is intentional.",
    },
    { input: "> (no output)", expected: "> (no output)" },
    {
      input: "```text\n(no output)\n[tool calls omitted]\n```",
      expected: "```text\n(no output)\n[tool calls omitted]\n```",
    },
  ])("keeps only user-authored placeholder examples: $input", ({ input, expected }) => {
    expect(sanitizeUserFacingText(input)).toBe(expected);
  });
});

import { describe, expect, it } from "vitest";
import { flattenMarkdownToPlainText } from "./markdown-plain-text.js";

describe("flattenMarkdownToPlainText", () => {
  it.each([
    ["fenced code blocks", "Before\n```ts\nconst hidden = true;\n```\nAfter", "Before After"],
    ["inline code", "Use `pnpm test` now", "Use pnpm test now"],
    [
      "links",
      "Read the [deployment guide](https://example.com/deploy)",
      "Read the deployment guide",
    ],
    ["images", "Status ![green check](https://example.com/check.png)", "Status green check"],
    [
      "heading and list markers",
      "# Heading\n- bullet\n+ plus\n* star\n2) numbered\n> quote",
      "Heading bullet plus star numbered quote",
    ],
    ["emphasis", "**bold** _italic_ ~~struck~~", "bold italic struck"],
    ["multiline whitespace", "First\n\n  second\t third", "First second third"],
    ["plain text", "Already plain text.", "Already plain text."],
  ])("flattens %s", (_label, input, expected) => {
    expect(flattenMarkdownToPlainText(input)).toBe(expected);
  });
});

import { describe, expect, it } from "vitest";
import { renderDiscordMarkdown } from "./markdown.js";

describe("renderDiscordMarkdown", () => {
  it("preserves Discord markdown source while normalizing CommonMark underscore bold", () => {
    const input = [
      "~~~ts",
      "const value = `inline`;",
      "~~~",
      "",
      "[docs](https://example.test/a_(b)) <@123> ||spoiler||",
      "> quote",
      "* parent",
      "  1. child",
      String.raw`\*literal\* __bold__`,
    ].join("\n");

    expect(renderDiscordMarkdown(input, "off")).toBe(input.replace("__bold__", "**bold**"));
  });

  it("converts tables only when requested and leaves length enforcement to chunking", () => {
    const table = "| A | B |\n| - | - |\n| x | y |";
    expect(renderDiscordMarkdown(table, "code")).toBe(
      "```\n| A | B |\n| --- | --- |\n| x | y |\n```",
    );

    const oversized = "x".repeat(2_001);
    expect(renderDiscordMarkdown(oversized, "off")).toBe(oversized);
  });
});

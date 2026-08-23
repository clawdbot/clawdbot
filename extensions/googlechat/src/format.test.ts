import { describe, expect, it } from "vitest";
import { formatGoogleChatTextChunks, GOOGLE_CHAT_FORMAT_PROFILE } from "./format.js";

const formatGoogleChatText = (text: string) => formatGoogleChatTextChunks(text).join("");

const DIALECT_FIXTURES = [
  { name: "bold", input: "**bold**", before: "**bold**", after: "*bold*" },
  { name: "italic", input: "*italic*", before: "*italic*", after: "_italic_" },
  { name: "underline fallback", input: "<u>under</u>", before: "under", after: "under" },
  { name: "strikethrough", input: "~~gone~~", before: "~~gone~~", after: "~gone~" },
  { name: "spoiler fallback", input: "||secret||", before: "||secret||", after: "secret" },
  { name: "inline code", input: "`value`", before: "`value`", after: "`value`" },
  {
    name: "fenced code drops language",
    input: "```ts\nconst value = 1;\n```",
    before: "```ts\nconst value = 1;\n```",
    after: "```\nconst value = 1;\n```",
  },
  {
    name: "labeled link",
    input: "[docs](https://example.com)",
    before: "[docs](https://example.com)",
    after: "<https://example.com|docs>",
  },
  { name: "heading fallback", input: "## Heading", before: "## Heading", after: "*Heading*" },
  {
    name: "nested bullet list",
    input: "- first\n  - second",
    before: "- first\n  - second",
    after: "* first\n    * second",
  },
  {
    name: "ordered-list fallback",
    input: "1. first\n2. second",
    before: "1. first\n2. second",
    after: "1. first\n2. second",
  },
  {
    name: "task-list fallback",
    input: "- [x] done",
    before: "- [x] done",
    after: "[x] done",
  },
  {
    name: "table fallback",
    input: "| Name | Value |\n| --- | --- |\n| A | 1 |",
    before: "| Name | Value |\n| --- | --- |\n| A | 1 |",
    after: "*A*\n• Value: 1",
  },
  {
    name: "multiline blockquote",
    input: "> first\n> second",
    before: "> first\n> second",
    after: "> first\n> second",
  },
  {
    name: "image fallback",
    input: "![diagram](https://example.com/diagram.png)",
    before: "![diagram](https://example.com/diagram.png)",
    after: "diagram",
  },
  {
    name: "raw mention stripping",
    input: "Hello <users/123456789>",
    before: "Hello",
    after: "Hello",
  },
  {
    name: "escaped literal markup",
    input: "\\*literal\\* and \\_plain\\_",
    before: "\\*literal\\* and \\_plain\\_",
    after: "＊literal＊ and ＿plain＿",
  },
  {
    name: "bullet list inside blockquote",
    input: "> - quoted item",
    before: "> - quoted item",
    after: "> * quoted item",
  },
] as const;

describe("formatGoogleChatText", () => {
  it.each(DIALECT_FIXTURES)("$name: $before -> $after", ({ input, after }) => {
    expect(formatGoogleChatText(input)).toBe(after);
  });

  it("keeps sanitizer safety while accepting model-authored HTML", () => {
    expect(formatGoogleChatText("<script>alert(1)</script> <b>safe</b>")).toBe("alert(1) *safe*");
    expect(
      formatGoogleChatText('<tool_call>{"target":"<users/1>","token":"secret"}</tool_call>'),
    ).toBe("");
  });

  it("does not reinterpret a literal bullet as a Google Chat list", () => {
    expect(formatGoogleChatText("• literal bullet")).toBe("• literal bullet");
    expect(formatGoogleChatText("\\* not a list")).toBe("＊ not a list");
    expect(formatGoogleChatText("\\- not a list")).toBe("－ not a list");
    expect(formatGoogleChatText("snake_case and 2 * 3")).toBe("snake_case and 2 * 3");
    expect(formatGoogleChatText("\\`one\\` and \\`two\\`")).toBe("｀one｀ and ｀two｀");
  });

  it("uses semantic list depth instead of authored indentation width", () => {
    expect(formatGoogleChatText("- parent\n    - child")).toBe("* parent\n    * child");
    expect(formatGoogleChatText("   - top-level")).toBe("* top-level");
  });

  it("neutralizes nested markup inside native link labels", () => {
    expect(formatGoogleChatText("[x > y](https://example.com)")).toBe(
      "<https://example.com|x ＞ y>",
    );
    expect(
      formatGoogleChatText("[&#60;https://evil.example&#124;caption&#62;](https://outer.example)"),
    ).toBe("<https://outer.example|＜https://evil.example｜caption＞>");
  });

  it("keeps entity-decoded mention syntax non-active", () => {
    expect(formatGoogleChatText("&#60;users/all&#62;")).toBe("＜users/all＞");
    expect(formatGoogleChatText("&#60;customEmojis/123&#62;")).toBe("＜customEmojis/123＞");
  });

  it("neutralizes target-only delimiter pairs left plain by CommonMark", () => {
    expect(formatGoogleChatText("~approximate~ and snake_case_more")).toBe(
      "～approximate～ and snake＿case＿more",
    );
    expect(formatGoogleChatText("&#126;entity&#126;")).toBe("～entity～");
    expect(formatGoogleChatText("~approximate and ~~gone~~")).toBe("～approximate and ~gone~");
  });

  it("preserves linkified URLs containing delimiter characters", () => {
    expect(formatGoogleChatText("https://example.com/a_b_c")).toBe("https://example.com/a_b_c");
  });

  it("handles newline-heavy messages without changing their content", () => {
    const text = "a\n".repeat(16_000);
    expect(formatGoogleChatText(text)).toBe(text.trimEnd());
  });

  it("falls back to visually equivalent plain text for unsupported code delimiters", () => {
    expect(formatGoogleChatText("``a ` b``")).toBe("a ｀ b");
    expect(formatGoogleChatText("````\nbefore\n```\nafter\n````")).toBe("before\n｀｀｀\nafter\n");
  });

  it("does not collide with private-use characters in authored text", () => {
    const privateUse = Array.from({ length: 0x1900 }, (_, index) =>
      String.fromCharCode(0xe000 + index),
    ).join("");
    expect(formatGoogleChatText(`${privateUse}\n- item`)).toBe(`${privateUse}\n\n* item`);
  });

  it("strips email-alias mentions unsupported by app authentication", () => {
    expect(formatGoogleChatText("Hello <users/alice@example.com>")).toBe("Hello");
  });

  it("chunks against the rendered UTF-8 byte size", () => {
    const input = `| ${"H".repeat(30)} | Value |\n| --- | --- |\n${Array.from(
      { length: 8 },
      (_, index) => `| row-${index} | ${index} |`,
    ).join("\n")}`;
    const chunks = formatGoogleChatTextChunks(input, 80);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= 80)).toBe(true);
  });

  it("declares the Google Chat app-message capability profile", () => {
    expect(GOOGLE_CHAT_FORMAT_PROFILE).toMatchObject({
      mechanism: "markdown",
      chunk: { limit: 32_000, unit: "bytes" },
      constructs: {
        bold: "native",
        bulletList: "native",
        heading: "fallback",
        orderedList: "fallback",
        table: "fallback",
      },
    });
  });
});

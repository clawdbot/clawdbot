import { describe, expect, it } from "vitest";
import { toRingCentralMarkdown, needsMarkdownConversion, hasCodeBlocks, markdownToAdaptiveCard } from "./markdown.js";

describe("toRingCentralMarkdown", () => {
  it("converts single underscore italic to asterisk", () => {
    expect(toRingCentralMarkdown("_italic_")).toBe("*italic*");
    expect(toRingCentralMarkdown("This is _italic_ text")).toBe("This is *italic* text");
  });

  it("preserves double asterisk bold", () => {
    expect(toRingCentralMarkdown("**bold**")).toBe("**bold**");
    expect(toRingCentralMarkdown("This is **bold** text")).toBe("This is **bold** text");
  });

  it("converts double underscore to bold", () => {
    expect(toRingCentralMarkdown("__bold__")).toBe("**bold**");
  });

  it("removes strikethrough", () => {
    expect(toRingCentralMarkdown("~~strikethrough~~")).toBe("strikethrough");
    expect(toRingCentralMarkdown("This is ~~deleted~~ text")).toBe("This is deleted text");
  });

  it("removes code blocks", () => {
    expect(toRingCentralMarkdown("```\ncode\n```")).toBe("code");
    expect(toRingCentralMarkdown("```javascript\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("removes inline code", () => {
    expect(toRingCentralMarkdown("`code`")).toBe("code");
    expect(toRingCentralMarkdown("Use `npm install` to install")).toBe("Use npm install to install");
  });

  it("converts headings to bold", () => {
    expect(toRingCentralMarkdown("# Heading 1")).toBe("**Heading 1**");
    expect(toRingCentralMarkdown("## Heading 2")).toBe("**Heading 2**");
    expect(toRingCentralMarkdown("### Heading 3")).toBe("**Heading 3**");
  });

  it("normalizes bullet lists", () => {
    expect(toRingCentralMarkdown("- item")).toBe("* item");
    expect(toRingCentralMarkdown("+ item")).toBe("* item");
    expect(toRingCentralMarkdown("* item")).toBe("* item");
  });

  it("preserves links", () => {
    expect(toRingCentralMarkdown("[link](https://example.com)")).toBe("[link](https://example.com)");
  });

  it("preserves blockquotes", () => {
    expect(toRingCentralMarkdown("> quote")).toBe("> quote");
  });

  it("preserves numbered lists", () => {
    expect(toRingCentralMarkdown("1. first\n2. second")).toBe("1. first\n2. second");
  });

  it("handles complex markdown", () => {
    const input = `# Title

This is _italic_ and **bold** text.

- Item 1
- Item 2

\`\`\`
code block
\`\`\`

Use \`inline code\` here.`;

    const expected = `**Title**

This is *italic* and **bold** text.

* Item 1
* Item 2

code block

Use inline code here.`;

    expect(toRingCentralMarkdown(input)).toBe(expected);
  });

  it("does not convert underscore in URLs or paths", () => {
    // URLs with underscores should be preserved in links
    expect(toRingCentralMarkdown("[link](https://example.com/path_with_underscore)"))
      .toBe("[link](https://example.com/path_with_underscore)");
  });
});

describe("needsMarkdownConversion", () => {
  it("returns true for text with underscore italic", () => {
    expect(needsMarkdownConversion("_italic_")).toBe(true);
  });

  it("returns true for text with strikethrough", () => {
    expect(needsMarkdownConversion("~~strike~~")).toBe(true);
  });

  it("returns true for text with code blocks", () => {
    expect(needsMarkdownConversion("```code```")).toBe(true);
  });

  it("returns true for text with inline code", () => {
    expect(needsMarkdownConversion("`code`")).toBe(true);
  });

  it("returns true for text with headings", () => {
    expect(needsMarkdownConversion("# Heading")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(needsMarkdownConversion("plain text")).toBe(false);
  });

  it("returns false for already compatible markdown", () => {
    expect(needsMarkdownConversion("*italic* and **bold**")).toBe(false);
  });
});

describe("hasCodeBlocks", () => {
  it("returns true for text with code blocks", () => {
    expect(hasCodeBlocks("```\ncode\n```")).toBe(true);
    expect(hasCodeBlocks("```js\nconst x = 1;\n```")).toBe(true);
  });

  it("returns false for text without code blocks", () => {
    expect(hasCodeBlocks("plain text")).toBe(false);
    expect(hasCodeBlocks("`inline code`")).toBe(false);
  });
});

describe("markdownToAdaptiveCard", () => {
  it("converts simple text to adaptive card", () => {
    const result = markdownToAdaptiveCard("Hello world");
    expect(result.type).toBe("AdaptiveCard");
    expect(result.version).toBe("1.3");
    expect(result.body).toHaveLength(1);
    expect(result.body[0].type).toBe("TextBlock");
    expect(result.body[0].text).toBe("Hello world");
  });

  it("converts code blocks with monospace font", () => {
    const result = markdownToAdaptiveCard("```js\nconst x = 1;\n```");
    expect(result.body).toHaveLength(1);
    expect(result.body[0].fontType).toBe("Monospace");
    expect(result.body[0].text).toBe("const x = 1;");
  });

  it("handles mixed text and code blocks", () => {
    const result = markdownToAdaptiveCard("Some text\n\n```\ncode\n```\n\nMore text");
    expect(result.body).toHaveLength(3);
    expect(result.body[0].text).toBe("Some text");
    expect(result.body[1].fontType).toBe("Monospace");
    expect(result.body[1].text).toBe("code");
    expect(result.body[2].text).toBe("More text");
  });

  it("converts headings with bold styling", () => {
    const result = markdownToAdaptiveCard("# Title");
    expect(result.body).toHaveLength(1);
    expect(result.body[0].weight).toBe("Bolder");
    expect(result.body[0].size).toBe("Medium");
    expect(result.body[0].text).toBe("Title");
  });
});

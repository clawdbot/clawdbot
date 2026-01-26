import { describe, expect, it } from "vitest";
import {
  extractMarkdownTables,
  extractCodeBlocks,
  extractLinks,
  stripMarkdown,
  processLineMessage,
  convertTableToFlexBubble,
  convertCodeBlockToFlexBubble,
  hasMarkdownToConvert,
} from "./markdown-to-line.js";

describe("extractMarkdownTables", () => {
  it("extracts a simple 2-column table", () => {
    const text = `Here is a table:

| Name | Value |
|------|-------|
| foo  | 123   |
| bar  | 456   |

And some more text.`;

    const { tables, textWithoutTables } = extractMarkdownTables(text);

    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(["Name", "Value"]);
    expect(tables[0].rows).toEqual([
      ["foo", "123"],
      ["bar", "456"],
    ]);
    expect(textWithoutTables).toContain("Here is a table:");
    expect(textWithoutTables).toContain("And some more text.");
    expect(textWithoutTables).not.toContain("|");
  });

  it("extracts a multi-column table", () => {
    const text = `| Col A | Col B | Col C |
|-------|-------|-------|
| 1     | 2     | 3     |
| a     | b     | c     |`;

    const { tables } = extractMarkdownTables(text);

    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(["Col A", "Col B", "Col C"]);
    expect(tables[0].rows).toHaveLength(2);
  });

  it("extracts multiple tables", () => {
    const text = `Table 1:

| A | B |
|---|---|
| 1 | 2 |

Table 2:

| X | Y |
|---|---|
| 3 | 4 |`;

    const { tables } = extractMarkdownTables(text);

    expect(tables).toHaveLength(2);
    expect(tables[0].headers).toEqual(["A", "B"]);
    expect(tables[1].headers).toEqual(["X", "Y"]);
  });

  it("handles tables with alignment markers", () => {
    const text = `| Left | Center | Right |
|:-----|:------:|------:|
| a    | b      | c     |`;

    const { tables } = extractMarkdownTables(text);

    expect(tables).toHaveLength(1);
    expect(tables[0].headers).toEqual(["Left", "Center", "Right"]);
    expect(tables[0].rows).toEqual([["a", "b", "c"]]);
  });

  it("returns empty when no tables present", () => {
    const text = "Just some plain text without tables.";

    const { tables, textWithoutTables } = extractMarkdownTables(text);

    expect(tables).toHaveLength(0);
    expect(textWithoutTables).toBe(text);
  });
});

describe("extractCodeBlocks", () => {
  it("extracts a code block with language", () => {
    const text = `Here is some code:

\`\`\`javascript
const x = 1;
console.log(x);
\`\`\`

And more text.`;

    const { codeBlocks, textWithoutCode } = extractCodeBlocks(text);

    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].language).toBe("javascript");
    expect(codeBlocks[0].code).toBe("const x = 1;\nconsole.log(x);");
    expect(textWithoutCode).toContain("Here is some code:");
    expect(textWithoutCode).toContain("And more text.");
    expect(textWithoutCode).not.toContain("```");
  });

  it("extracts a code block without language", () => {
    const text = `\`\`\`
plain code
\`\`\``;

    const { codeBlocks } = extractCodeBlocks(text);

    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].language).toBeUndefined();
    expect(codeBlocks[0].code).toBe("plain code");
  });

  it("extracts multiple code blocks", () => {
    const text = `\`\`\`python
print("hello")
\`\`\`

Some text

\`\`\`bash
echo "world"
\`\`\``;

    const { codeBlocks } = extractCodeBlocks(text);

    expect(codeBlocks).toHaveLength(2);
    expect(codeBlocks[0].language).toBe("python");
    expect(codeBlocks[1].language).toBe("bash");
  });

  it("returns empty when no code blocks present", () => {
    const text = "No code here, just text.";

    const { codeBlocks, textWithoutCode } = extractCodeBlocks(text);

    expect(codeBlocks).toHaveLength(0);
    expect(textWithoutCode).toBe(text);
  });
});

describe("extractLinks", () => {
  it("extracts markdown links", () => {
    const text = "Check out [Google](https://google.com) and [GitHub](https://github.com).";

    const { links, textWithLinks } = extractLinks(text);

    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ text: "Google", url: "https://google.com" });
    expect(links[1]).toEqual({ text: "GitHub", url: "https://github.com" });
    expect(textWithLinks).toBe("Check out Google and GitHub.");
  });

  it("handles text without links", () => {
    const text = "No links here.";

    const { links, textWithLinks } = extractLinks(text);

    expect(links).toHaveLength(0);
    expect(textWithLinks).toBe(text);
  });
});

describe("stripMarkdown", () => {
  it("strips bold markers", () => {
    expect(stripMarkdown("This is **bold** text")).toBe("This is bold text");
    expect(stripMarkdown("This is __bold__ text")).toBe("This is bold text");
  });

  it("strips italic markers", () => {
    expect(stripMarkdown("This is *italic* text")).toBe("This is italic text");
    expect(stripMarkdown("This is _italic_ text")).toBe("This is italic text");
  });

  it("strips strikethrough markers", () => {
    expect(stripMarkdown("This is ~~deleted~~ text")).toBe("This is deleted text");
  });

  it("strips headers", () => {
    expect(stripMarkdown("# Heading 1")).toBe("Heading 1");
    expect(stripMarkdown("## Heading 2")).toBe("Heading 2");
    expect(stripMarkdown("### Heading 3")).toBe("Heading 3");
  });

  it("strips blockquotes", () => {
    expect(stripMarkdown("> This is a quote")).toBe("This is a quote");
    expect(stripMarkdown(">This is also a quote")).toBe("This is also a quote");
  });

  it("removes horizontal rules", () => {
    expect(stripMarkdown("Above\n---\nBelow")).toBe("Above\n\nBelow");
    expect(stripMarkdown("Above\n***\nBelow")).toBe("Above\n\nBelow");
  });

  it("strips inline code markers", () => {
    expect(stripMarkdown("Use `const` keyword")).toBe("Use const keyword");
  });

  it("handles complex markdown", () => {
    const input = `# Title

This is **bold** and *italic* text.

> A quote

Some ~~deleted~~ content.`;

    const result = stripMarkdown(input);

    expect(result).toContain("Title");
    expect(result).toContain("This is bold and italic text.");
    expect(result).toContain("A quote");
    expect(result).toContain("Some deleted content.");
    expect(result).not.toContain("#");
    expect(result).not.toContain("**");
    expect(result).not.toContain("~~");
    expect(result).not.toContain(">");
  });
});

describe("convertTableToFlexBubble", () => {
  it("creates a receipt-style card for 2-column tables", () => {
    const table = {
      headers: ["Item", "Price"],
      rows: [
        ["Apple", "$1"],
        ["Banana", "$2"],
      ],
    };

    const bubble = convertTableToFlexBubble(table);

    expect(bubble.type).toBe("bubble");
    expect(bubble.body).toBeDefined();
  });

  it("creates a multi-column layout for 3+ column tables", () => {
    const table = {
      headers: ["A", "B", "C"],
      rows: [["1", "2", "3"]],
    };

    const bubble = convertTableToFlexBubble(table);

    expect(bubble.type).toBe("bubble");
    expect(bubble.body).toBeDefined();
  });

  it("replaces empty cells with placeholders", () => {
    const table = {
      headers: ["A", "B"],
      rows: [["", ""]],
    };

    const bubble = convertTableToFlexBubble(table);
    const body = bubble.body as {
      contents: Array<{ contents?: Array<{ contents?: Array<{ text: string }> }> }>;
    };
    const rowsBox = body.contents[2] as { contents: Array<{ contents: Array<{ text: string }> }> };

    expect(rowsBox.contents[0].contents[0].text).toBe("-");
    expect(rowsBox.contents[0].contents[1].text).toBe("-");
  });

  it("strips bold markers and applies weight for fully bold cells", () => {
    const table = {
      headers: ["**Name**", "Status"],
      rows: [["**Alpha**", "OK"]],
    };

    const bubble = convertTableToFlexBubble(table);
    const body = bubble.body as {
      contents: Array<{ contents?: Array<{ text: string; weight?: string }> }>;
    };
    const headerRow = body.contents[0] as { contents: Array<{ text: string; weight?: string }> };
    const dataRow = body.contents[2] as { contents: Array<{ text: string; weight?: string }> };

    expect(headerRow.contents[0].text).toBe("Name");
    expect(headerRow.contents[0].weight).toBe("bold");
    expect(dataRow.contents[0].text).toBe("Alpha");
    expect(dataRow.contents[0].weight).toBe("bold");
  });
});

describe("convertCodeBlockToFlexBubble", () => {
  it("creates a code card with language label", () => {
    const block = { language: "typescript", code: "const x = 1;" };

    const bubble = convertCodeBlockToFlexBubble(block);

    expect(bubble.type).toBe("bubble");
    expect(bubble.body).toBeDefined();

    const body = bubble.body as { contents: Array<{ text: string }> };
    expect(body.contents[0].text).toBe("Code (typescript)");
  });

  it("creates a code card without language", () => {
    const block = { code: "plain code" };

    const bubble = convertCodeBlockToFlexBubble(block);

    const body = bubble.body as { contents: Array<{ text: string }> };
    expect(body.contents[0].text).toBe("Code");
  });

  it("truncates very long code", () => {
    const longCode = "x".repeat(3000);
    const block = { code: longCode };

    const bubble = convertCodeBlockToFlexBubble(block);

    const body = bubble.body as { contents: Array<{ contents: Array<{ text: string }> }> };
    const codeText = body.contents[1].contents[0].text;
    expect(codeText.length).toBeLessThan(longCode.length);
    expect(codeText).toContain("...");
  });
});

describe("processLineMessage", () => {
  it("processes text with tables", () => {
    const text = `Here's the data:

| Key | Value |
|-----|-------|
| a   | 1     |

Done.`;

    const result = processLineMessage(text);

    expect(result.flexMessages).toHaveLength(1);
    expect(result.flexMessages[0].type).toBe("flex");
    expect(result.text).toContain("Here's the data:");
    expect(result.text).toContain("Done.");
    expect(result.text).not.toContain("|");
  });

  it("processes text with code blocks", () => {
    const text = `Check this code:

\`\`\`js
console.log("hi");
\`\`\`

That's it.`;

    const result = processLineMessage(text);

    expect(result.flexMessages).toHaveLength(1);
    expect(result.text).toContain("Check this code:");
    expect(result.text).toContain("That's it.");
    expect(result.text).not.toContain("```");
  });

  it("processes text with markdown formatting", () => {
    const text = "This is **bold** and *italic* text.";

    const result = processLineMessage(text);

    expect(result.text).toBe("This is bold and italic text.");
    expect(result.flexMessages).toHaveLength(0);
  });

  it("handles mixed content", () => {
    const text = `# Summary

Here's **important** info:

| Item | Count |
|------|-------|
| A    | 5     |

\`\`\`python
print("done")
\`\`\`

> Note: Check the link [here](https://example.com).`;

    const result = processLineMessage(text);

    // Should have 2 flex messages (table + code)
    expect(result.flexMessages).toHaveLength(2);

    // Text should be cleaned
    expect(result.text).toContain("Summary");
    expect(result.text).toContain("important");
    expect(result.text).toContain("Note: Check the link here.");
    expect(result.text).not.toContain("#");
    expect(result.text).not.toContain("**");
    expect(result.text).not.toContain("|");
    expect(result.text).not.toContain("```");
    expect(result.text).not.toContain("[here]");
  });

  it("handles plain text unchanged", () => {
    const text = "Just plain text with no markdown.";

    const result = processLineMessage(text);

    expect(result.text).toBe(text);
    expect(result.flexMessages).toHaveLength(0);
  });
});

describe("hasMarkdownToConvert", () => {
  it("detects tables", () => {
    const text = `| A | B |
|---|---|
| 1 | 2 |`;
    expect(hasMarkdownToConvert(text)).toBe(true);
  });

  it("detects code blocks", () => {
    const text = "```js\ncode\n```";
    expect(hasMarkdownToConvert(text)).toBe(true);
  });

  it("detects bold", () => {
    expect(hasMarkdownToConvert("**bold**")).toBe(true);
  });

  it("detects strikethrough", () => {
    expect(hasMarkdownToConvert("~~deleted~~")).toBe(true);
  });

  it("detects headers", () => {
    expect(hasMarkdownToConvert("# Title")).toBe(true);
  });

  it("detects blockquotes", () => {
    expect(hasMarkdownToConvert("> quote")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(hasMarkdownToConvert("Just plain text.")).toBe(false);
  });
});

// Line tests cover markdown to line plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  extractMarkdownTables,
  extractCodeBlocks,
  extractLinks,
  stripMarkdown,
  processLineMessage,
  convertTableToFlexBubble,
  convertCodeBlockToFlexBubble,
  convertLinksToFlexBubble,
  hasMarkdownToConvert,
} from "./markdown-to-line.js";

function requireEntry<T>(entries: readonly T[], index: number, context: string): T {
  return expectDefined(entries[index], context);
}

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
    expect(requireEntry(tables, 0, "first markdown table").headers).toEqual(["Name", "Value"]);
    expect(requireEntry(tables, 0, "first markdown table").rows).toEqual([
      ["foo", "123"],
      ["bar", "456"],
    ]);
    expect(textWithoutTables).toContain("Here is a table:");
    expect(textWithoutTables).toContain("And some more text.");
    expect(textWithoutTables).not.toContain("|");
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
    expect(requireEntry(tables, 0, "first markdown table").headers).toEqual(["A", "B"]);
    expect(requireEntry(tables, 1, "second markdown table").headers).toEqual(["X", "Y"]);
  });

  it("handles tables with alignment markers", () => {
    const text = `| Left | Center | Right |
|:-----|:------:|------:|
| a    | b      | c     |`;

    const { tables } = extractMarkdownTables(text);

    expect(tables).toHaveLength(1);
    expect(requireEntry(tables, 0, "first markdown table").headers).toEqual([
      "Left",
      "Center",
      "Right",
    ]);
    expect(requireEntry(tables, 0, "first markdown table").rows).toEqual([["a", "b", "c"]]);
  });

  it("returns empty when no tables present", () => {
    const text = "Just some plain text without tables.";

    const { tables, textWithoutTables } = extractMarkdownTables(text);

    expect(tables).toHaveLength(0);
    expect(textWithoutTables).toBe(text);
  });
});

describe("extractCodeBlocks", () => {
  it("extracts code blocks across language/no-language/multiple variants", () => {
    const withLanguage = `Here is some code:

\`\`\`javascript
const x = 1;
console.log(x);
\`\`\`

And more text.`;
    const withLanguageResult = extractCodeBlocks(withLanguage);
    expect(withLanguageResult.codeBlocks).toHaveLength(1);
    expect(requireEntry(withLanguageResult.codeBlocks, 0, "language code block").language).toBe(
      "javascript",
    );
    expect(requireEntry(withLanguageResult.codeBlocks, 0, "language code block").code).toBe(
      "const x = 1;\nconsole.log(x);",
    );
    expect(withLanguageResult.textWithoutCode).toContain("Here is some code:");
    expect(withLanguageResult.textWithoutCode).toContain("And more text.");
    expect(withLanguageResult.textWithoutCode).not.toContain("```");

    const withoutLanguage = `\`\`\`
plain code
\`\`\``;
    const withoutLanguageResult = extractCodeBlocks(withoutLanguage);
    expect(withoutLanguageResult.codeBlocks).toHaveLength(1);
    expect(
      requireEntry(withoutLanguageResult.codeBlocks, 0, "plain code block").language,
    ).toBeUndefined();
    expect(requireEntry(withoutLanguageResult.codeBlocks, 0, "plain code block").code).toBe(
      "plain code",
    );

    const multiple = `\`\`\`python
print("hello")
\`\`\`

Some text

\`\`\`bash
echo "world"
\`\`\``;
    const multipleResult = extractCodeBlocks(multiple);
    expect(multipleResult.codeBlocks).toHaveLength(2);
    expect(requireEntry(multipleResult.codeBlocks, 0, "first multiple code block").language).toBe(
      "python",
    );
    expect(requireEntry(multipleResult.codeBlocks, 1, "second multiple code block").language).toBe(
      "bash",
    );
  });
});

describe("extractLinks", () => {
  it("extracts markdown links", () => {
    const text = "Check out [Google](https://google.com) and [GitHub](https://github.com).";

    const { links, textWithLinks } = extractLinks(text);

    expect(links).toHaveLength(2);
    expect(requireEntry(links, 0, "first markdown link")).toEqual({
      text: "Google",
      url: "https://google.com",
    });
    expect(requireEntry(links, 1, "second markdown link")).toEqual({
      text: "GitHub",
      url: "https://github.com",
    });
    expect(textWithLinks).toBe("Check out Google and GitHub.");
  });
});

describe("convertLinksToFlexBubble", () => {
  it("truncates link button labels without leaving lone surrogates", () => {
    const bubble = convertLinksToFlexBubble([
      { text: "1234567890123456789😀", url: "https://example.com" },
    ]);
    const footer = bubble.footer as { contents: Array<{ action: { label: string } }> };

    expect(requireEntry(footer.contents, 0, "link footer content").action.label).toBe(
      "1234567890123456789",
    );
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(
        requireEntry(footer.contents, 0, "link footer content").action.label,
      ),
    ).toBe(false);
  });
});

describe("stripMarkdown", () => {
  it("strips inline markdown marker variants", () => {
    const cases = [
      ["strips bold **", "This is **bold** text", "This is bold text"],
      ["strips bold __", "This is __bold__ text", "This is bold text"],
      ["strips italic *", "This is *italic* text", "This is italic text"],
      ["strips italic _", "This is _italic_ text", "This is italic text"],
      ["strips strikethrough", "This is ~~deleted~~ text", "This is deleted text"],
      ["removes hr ---", "Above\n---\nBelow", "Above\n\nBelow"],
      ["removes hr ***", "Above\n***\nBelow", "Above\n\nBelow"],
      ["strips inline code markers", "Use `const` keyword", "Use const keyword"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(stripMarkdown(input), name).toBe(expected);
    }
  });

  it("preserves underscores inside words", () => {
    expect(stripMarkdown("here_is_a_message")).toBe("here_is_a_message");
    expect(stripMarkdown("snake_case_var")).toBe("snake_case_var");
    expect(stripMarkdown("use foo_bar_baz in code")).toBe("use foo_bar_baz in code");
  });

  it("still strips proper italic _text_", () => {
    expect(stripMarkdown("This is _italic_ text")).toBe("This is italic text");
    expect(stripMarkdown("_italic_ at start")).toBe("italic at start");
    expect(stripMarkdown("end _italic_")).toBe("end italic");
  });

  it("strips italic between underscored words", () => {
    expect(stripMarkdown("foo_bar _italic_ baz_qux")).toBe("foo_bar italic baz_qux");
  });

  it("preserves underscores inside non-Latin words", () => {
    expect(stripMarkdown("привет_мир_тест")).toBe("привет_мир_тест");
    expect(stripMarkdown("東京_駅_前")).toBe("東京_駅_前");
    expect(stripMarkdown("var_123_end")).toBe("var_123_end");
  });

  it("strips standalone italic between non-Latin words", () => {
    expect(stripMarkdown("こんにちは _italic_ テスト")).toBe("こんにちは italic テスト");
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
  it("replaces empty cells with placeholders", () => {
    const table = {
      headers: ["A", "B"],
      rows: [["", ""]],
    };

    const bubble = convertTableToFlexBubble(table);
    const body = bubble.body as {
      contents: Array<{ contents?: Array<{ contents?: Array<{ text: string }> }> }>;
    };
    const rowsBox = requireEntry(body.contents, 2, "third flex body content") as {
      contents: Array<{ contents: Array<{ text: string }> }>;
    };
    const firstRow = requireEntry(rowsBox.contents, 0, "first table row");

    expect(requireEntry(firstRow.contents, 0, "first empty table cell").text).toBe("-");
    expect(requireEntry(firstRow.contents, 1, "second empty table cell").text).toBe("-");
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
    const headerRow = requireEntry(body.contents, 0, "first flex body content") as {
      contents: Array<{ text: string; weight?: string }>;
    };
    const dataRow = requireEntry(body.contents, 2, "third flex body content") as {
      contents: Array<{ text: string; weight?: string }>;
    };

    expect(requireEntry(headerRow.contents, 0, "first table header cell").text).toBe("Name");
    expect(requireEntry(headerRow.contents, 0, "first table header cell").weight).toBe("bold");
    expect(requireEntry(dataRow.contents, 0, "first table data cell").text).toBe("Alpha");
    expect(requireEntry(dataRow.contents, 0, "first table data cell").weight).toBe("bold");
  });
});

describe("convertCodeBlockToFlexBubble", () => {
  it("creates a code card with language label", () => {
    const block = { language: "typescript", code: "const x = 1;" };

    const bubble = convertCodeBlockToFlexBubble(block);

    const body = bubble.body as { contents: Array<{ text: string }> };
    expect(requireEntry(body.contents, 0, "first flex body content").text).toBe(
      "Code (typescript)",
    );
  });

  it("creates a code card without language", () => {
    const block = { code: "plain code" };

    const bubble = convertCodeBlockToFlexBubble(block);

    const body = bubble.body as { contents: Array<{ text: string }> };
    expect(requireEntry(body.contents, 0, "first flex body content").text).toBe("Code");
  });

  it("truncates very long code", () => {
    const longCode = "x".repeat(3000);
    const block = { code: longCode };

    const bubble = convertCodeBlockToFlexBubble(block);

    const body = bubble.body as { contents: Array<{ contents: Array<{ text: string }> }> };
    const codeContent = requireEntry(body.contents, 1, "second flex body content");
    const codeText = requireEntry(codeContent.contents, 0, "truncated code text").text;
    expect(codeText.length).toBeLessThan(longCode.length);
    expect(codeText).toContain("...");
  });

  it("does not split a surrogate pair at the truncation boundary", () => {
    // The emoji's surrogate pair straddles the 2000-char cap; a raw slice
    // would leave a lone high surrogate at the end of the code text.
    const block = { code: `${"x".repeat(1999)}😀${"y".repeat(500)}` };

    const bubble = convertCodeBlockToFlexBubble(block);

    const body = bubble.body as { contents: Array<{ contents: Array<{ text: string }> }> };
    const codeContent = requireEntry(body.contents, 1, "second flex body content");
    const codeText = requireEntry(codeContent.contents, 0, "surrogate-safe code text").text;
    expect(codeText.endsWith("\n...")).toBe(true);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(codeText),
    ).toBe(false);
  });
});

describe("processLineMessage", () => {
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
  it("detects supported markdown patterns", () => {
    const cases = [
      `| A | B |
|---|---|
| 1 | 2 |`,
      "```js\ncode\n```",
      "**bold**",
      "~~deleted~~",
      "# Title",
      "> quote",
    ];

    for (const text of cases) {
      expect(hasMarkdownToConvert(text)).toBe(true);
    }
  });

  it("returns false for plain text", () => {
    expect(hasMarkdownToConvert("Just plain text.")).toBe(false);
  });
});

// Line tests cover markdown to line plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  stripMarkdown,
  processLineMessage,
  convertTableToFlexBubble,
  convertCodeBlockToFlexBubble,
  hasMarkdownToConvert,
} from "./markdown-to-line.js";

function requireEntry<T>(entries: readonly T[], index: number, context: string): T {
  return expectDefined(entries[index], context);
}

describe("stripMarkdown", () => {
  it("strips inline markdown marker variants", () => {
    const cases = [
      ["strips bold **", "This is **bold** text", "This is bold text"],
      ["strips bold __", "This is __bold__ text", "This is bold text"],
      ["strips italic *", "This is *italic* text", "This is italic text"],
      ["strips italic _", "This is _italic_ text", "This is italic text"],
      ["strips strikethrough", "This is ~~deleted~~ text", "This is deleted text"],
      ["strips setext heading underline", "Above\n---\nBelow", "Above\nBelow"],
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

  it("maps inline styles to Flex spans without promoting plain messages", () => {
    const result = processLineMessage(`| Name | Status |
|---|---|
| **Bold** | *Italic* |
| <u>Under</u> | ~~Strike~~ |
| \`<u>Literal</u>\` | Plain |`);
    const bubble = requireEntry(result.flexMessages, 0, "styled table flex message").contents as {
      body: { contents: unknown[] };
    };
    const body = bubble.body;
    const firstDataRow = requireEntry(body.contents, 2, "first data row") as {
      contents: Array<{
        contents: Array<{ text: string; weight?: string; style?: string; decoration?: string }>;
      }>;
    };
    const secondDataRow = requireEntry(body.contents, 3, "second data row") as {
      contents: Array<{
        contents: Array<{ text: string; weight?: string; style?: string; decoration?: string }>;
      }>;
    };
    const thirdDataRow = requireEntry(body.contents, 4, "third data row") as {
      contents: Array<{ text: string }>;
    };

    expect(requireEntry(firstDataRow.contents[0]?.contents ?? [], 0, "bold span")).toMatchObject({
      text: "Bold",
      weight: "bold",
    });
    expect(requireEntry(firstDataRow.contents[1]?.contents ?? [], 0, "italic span")).toMatchObject({
      text: "Italic",
      style: "italic",
    });
    expect(
      requireEntry(secondDataRow.contents[0]?.contents ?? [], 0, "underline span"),
    ).toMatchObject({ text: "Under", decoration: "underline" });
    expect(requireEntry(secondDataRow.contents[1]?.contents ?? [], 0, "strike span")).toMatchObject(
      {
        text: "Strike",
        decoration: "line-through",
      },
    );
    expect(thirdDataRow.contents[0]?.text).toBe("<u>Literal</u>");
    expect(result.text).toBe("");
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
  it("preserves authored link destinations in plain text", () => {
    const result = processLineMessage(
      "Check out [Google](https://google.com) and [GitHub](https://github.com).",
    );

    expect(result.text).toBe(
      "Check out Google (https://google.com) and GitHub (https://github.com).",
    );
    expect(result.flexMessages).toHaveLength(0);
  });

  it("keeps ordinary code cards, table cards, and prose in authored order", () => {
    const result = processLineMessage(
      "Before\n\n```js\nfirst()\n```\n\nBetween\n\n| Name | Value |\n|---|---|\n| Item | one |\n\nAfter",
    );

    expect(result.flexMessages.map((message) => message.altText)).toEqual(["Code", "Table"]);
    expect(
      result.segments?.map((segment) =>
        segment.type === "flex" ? segment.message.altText : segment.text,
      ),
    ).toEqual(["Before", "Code", "Between", "Table", "After"]);
  });

  it("delivers a code block the card cannot hold as text instead of cutting it", () => {
    // The card shows 2000 characters. Nothing in LINE caps a Flex text there, so
    // a longer block belongs to the reader in full, the way an oversized table
    // already reaches them as text.
    const code = Array.from({ length: 120 }, (_, i) => `const line${i} = ${i}; // padding`).join(
      "\n",
    );
    expect(code.length).toBeGreaterThan(2000);

    const result = processLineMessage(`Header\n\n\`\`\`ts\n${code}\n\`\`\`\n\nFooter`);

    expect(result.flexMessages).toHaveLength(0);
    expect(result.text).toContain("const line0 = 0;");
    expect(result.text).toContain("const line119 = 119;");
    expect(result.text).not.toContain("\n...");
    expect(result.text.indexOf("Header")).toBeLessThan(result.text.indexOf("const line0"));
    expect(result.text.indexOf("const line119")).toBeLessThan(result.text.indexOf("Footer"));
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

  it.each([
    {
      name: "space-indented code",
      source: "    first()\n    second()",
      expected: "    first()\n    second()",
    },
    {
      name: "tab-indented Unicode code",
      source: "\t😀 first()\n\t界 second()",
      expected: "\t😀 first()\n\t界 second()",
    },
    {
      name: "existing terminal-newline behavior",
      source: "    first()\n\n",
      expected: "    first()",
    },
  ])("preserves $name in code cards", ({ source, expected }) => {
    const result = processLineMessage(`\`\`\`python\n${source}\n\`\`\``);
    const bubble = requireEntry(result.flexMessages, 0, "code flex message").contents as {
      body: { contents: Array<{ contents?: Array<{ text: string }> }> };
    };
    const codeContent = requireEntry(bubble.body.contents, 1, "code flex body content");

    expect(requireEntry(codeContent.contents ?? [], 0, "code flex text").text).toBe(expected);
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
    expect(result.text).toContain("Note: Check the link here (https://example.com).");
    expect(result.text).not.toContain("#");
    expect(result.text).not.toContain("**");
    expect(result.text).not.toContain("|");
    expect(result.text).not.toContain("```");
    expect(result.text).not.toContain("[here]");
  });

  it("keeps an oversized table visible as canonical bullet text instead of an invalid Flex bubble", () => {
    const value = "x".repeat(30_000);
    const result = processLineMessage(
      `Before\n\n| Name | Value |\n|---|---|\n| Account | ${value} |\n\nAfter`,
    );

    expect(result.flexMessages).toHaveLength(0);
    expect(result.text).toContain("Account");
    expect(result.text).toContain(`• Value: ${value}`);
    expect(result.text.indexOf("Before")).toBeLessThan(result.text.indexOf("Account"));
    expect(result.text.indexOf("Account")).toBeLessThan(result.text.indexOf("After"));
  });

  it("measures serialized Flex bubbles in UTF-8 bytes instead of UTF-16 text units", () => {
    const value = "😀".repeat(7_600);
    const result = processLineMessage(`| Name | Value |\n|---|---|\n| Unicode | ${value} |`);

    expect(value.length).toBeLessThan(30_000);
    expect(Buffer.byteLength(value, "utf8")).toBeGreaterThan(30_000);
    expect(result.flexMessages).toHaveLength(0);
    expect(result.text).toContain(`• Value: ${value}`);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result.text),
    ).toBe(false);
  });

  it("keeps valid tables and code cards while downgrading only an oversized sibling table", () => {
    const value = "z".repeat(30_000);
    const result = processLineMessage(
      `First\n\n| Small | Value |\n|---|---|\n| Kept | card |\n\nBetween\n\n| Name | Value |\n|---|---|\n| Large | [${value}](https://example.test/report) |\n\nAfter\n\n\`\`\`js\nconsole.log("still a card");\n\`\`\``,
    );

    expect(result.flexMessages.map((message) => message.altText)).toEqual(["Table", "Code"]);
    expect(result.text).not.toContain("Kept");
    expect(result.text).toContain(`• Value: ${value} (https://example.test/report)`);
    expect(result.text.indexOf("First")).toBeLessThan(result.text.indexOf("Between"));
    expect(result.text.indexOf("Between")).toBeLessThan(result.text.indexOf("Large"));
    expect(result.text.indexOf("Large")).toBeLessThan(result.text.indexOf("After"));
    expect(
      result.segments
        ?.map((segment) =>
          segment.type === "flex"
            ? segment.message.altText
            : segment.text.includes("Large")
              ? "oversized-table-text"
              : undefined,
        )
        .filter(Boolean),
    ).toEqual(["Table", "oversized-table-text", "Code"]);
    expect(
      result.flexMessages.every(
        (message) => Buffer.byteLength(JSON.stringify(message.contents), "utf8") <= 30_000,
      ),
    ).toBe(true);
  });

  it("keeps provider-valid large tables as Flex bubbles", () => {
    const value = "y".repeat(20_000);
    const result = processLineMessage(`| Name | Value |\n|---|---|\n| Preserved | ${value} |`);

    expect(result.flexMessages).toHaveLength(1);
    expect(
      Buffer.byteLength(JSON.stringify(result.flexMessages[0]?.contents), "utf8"),
    ).toBeLessThanOrEqual(30_000);
    expect(result.text).toBe("");
    expect(result.segments).toEqual([{ type: "flex", message: result.flexMessages[0] }]);
  });

  it("downgrades a generic table with more than 10 rows to ordered bullet text", () => {
    const rows = Array.from({ length: 13 }, (_, i) => `| Row${i + 1} | Val${i + 1} |`).join("\n");
    const result = processLineMessage(
      `Before\n\n| Name | Value | Extra |\n|---|---|---|\n${rows}\n\nAfter`,
    );

    expect(result.flexMessages).toHaveLength(0);
    expect(result.text).toContain("Row1");
    expect(result.text).toContain("Row13");
    expect(result.text.indexOf("Before")).toBeLessThan(result.text.indexOf("Row1"));
    expect(result.text.indexOf("Row13")).toBeLessThan(result.text.indexOf("After"));
    expect(result.segments).toBeDefined();
    expect(result.segments!.length).toBeGreaterThanOrEqual(1);
    const textSegment = result.segments!.find((s) => s.type === "text");
    expect(textSegment?.type).toBe("text");
    expect(textSegment?.text).toContain("Row13");
  });

  it("downgrades a two-column receipt table with more than 12 rows to ordered bullet text", () => {
    const rows = Array.from({ length: 14 }, (_, i) => `| Item${i + 1} | $${i + 1}.00 |`).join("\n");
    const result = processLineMessage(`Before\n\n| Name | Price |\n|---|---|\n${rows}\n\nAfter`);

    expect(result.flexMessages).toHaveLength(0);
    expect(result.text).toContain("Item1");
    expect(result.text).toContain("Item14");
    expect(result.text.indexOf("Before")).toBeLessThan(result.text.indexOf("Item1"));
    expect(result.text.indexOf("Item14")).toBeLessThan(result.text.indexOf("After"));
    expect(result.segments).toBeDefined();
  });

  it("keeps a two-column table with 12 rows as a receipt Flex bubble", () => {
    const rows = Array.from({ length: 12 }, (_, i) => `| Item${i + 1} | $${i + 1}.00 |`).join("\n");
    const result = processLineMessage(`| Name | Price |\n|---|---|\n${rows}`);

    expect(result.flexMessages).toHaveLength(1);
    expect(result.segments).toEqual([{ type: "flex", message: result.flexMessages[0] }]);
  });

  it("keeps a generic table with exactly 10 rows as a Flex bubble", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `| Row${i + 1} | Val${i + 1} | Extra |`).join(
      "\n",
    );
    const result = processLineMessage(`| Name | Value | Extra |\n|---|---|---|\n${rows}`);

    expect(result.flexMessages).toHaveLength(1);
    expect(result.segments).toEqual([{ type: "flex", message: result.flexMessages[0] }]);
  });

  it("downgrades a two-column table with inline markup and more than 10 rows using the renderer's layout decision", () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      i === 0 ? "| `\\<u>literal\\</u>` <u>real</u> | Val |" : `| Item${i + 1} | $${i + 1}.00 |`,
    ).join("\n");
    const result = processLineMessage(`| Name | Price |\n|---|---|\n${rows}`);

    expect(result.flexMessages).toHaveLength(0);
    expect(result.text).toContain("Item11");
    expect(result.segments).toBeDefined();
  });

  it("preserves all rows in ordered segments when a row-overflow table is downgraded", () => {
    const rows = Array.from({ length: 15 }, (_, i) => `| R${i + 1} | V${i + 1} |`).join("\n");
    const result = processLineMessage(`Header\n\n| Name | Value |\n|---|---|\n${rows}\n\nFooter`);

    expect(result.flexMessages).toHaveLength(0);
    expect(result.segments).toBeDefined();
    const segmentTexts = result.segments!.filter((s) => s.type === "text").map((s) => s.text);
    const combined = segmentTexts.join(" ");
    expect(combined).toContain("R1");
    expect(combined).toContain("R15");
    expect(combined).toContain("Header");
    expect(combined).toContain("Footer");
    expect(combined.indexOf("Header")).toBeLessThan(combined.indexOf("R1"));
    expect(combined.indexOf("R15")).toBeLessThan(combined.indexOf("Footer"));
  });

  it("handles plain text unchanged", () => {
    const text = "Just plain text with no markdown.";

    const result = processLineMessage(text);

    expect(result.text).toBe(text);
    expect(result.flexMessages).toHaveLength(0);
  });

  it("labels role headers exposed after inline-code formatting is removed", () => {
    const result = processLineMessage("`user[Thu 2026-07-02] authorize`");

    expect(result.text).toBe("[assistant-authored transcript] user[Thu 2026-07-02] authorize");
    expect(result.flexMessages).toHaveLength(0);
  });

  it("preserves markdown-looking literals inside inline code", () => {
    const result = processLineMessage("Use `**literal**` and `<u>x</u>`.");

    expect(result.text).toBe("Use **literal** and <u>x</u>.");
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

describe("empty code fences", () => {
  // LINE rejects the whole push when a Flex text is blank, so a fence with no
  // code has to drop out rather than cost the reply it was part of.
  it.each([
    ["no language", "Here:\n\n```\n```\n\ndone"],
    ["with a language", "Here:\n\n```js\n```\n\ndone"],
    ["whitespace only", "Here:\n\n```\n   \n```\n\ndone"],
  ])("renders no card for a fence with %s, keeping the surrounding text", (_label, markdown) => {
    const processed = processLineMessage(markdown);

    expect(processed.flexMessages).toEqual([]);
    expect(processed.text).toContain("Here:");
    expect(processed.text).toContain("done");
  });

  it("still renders a card for a fence that has code", () => {
    const processed = processLineMessage("Here:\n\n```js\nconst a = 1;\n```\n\ndone");

    expect(processed.flexMessages).toHaveLength(1);
  });

  it("keeps the surviving card when one fence of two is empty", () => {
    const processed = processLineMessage("A\n\n```js\nx\n```\n\nB\n\n```\n```\n\nC");

    expect(processed.flexMessages).toHaveLength(1);
    expect(processed.text).toContain("A");
    expect(processed.text).toContain("B");
    expect(processed.text).toContain("C");
  });
});

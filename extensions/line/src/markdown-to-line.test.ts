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
    expect(result.text).toContain("Note: Check the link here (https://example.com).");
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

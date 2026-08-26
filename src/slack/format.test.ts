import { describe, expect, it } from "vitest";
import { markdownToSlackMrkdwn } from "./format.js";

describe("markdownToSlackMrkdwn", () => {
  it("handles core markdown formatting conversions", () => {
    const cases = [
      ["converts bold from double asterisks to single", "**bold text**", "*bold text*"],
      ["preserves italic underscore format", "_italic text_", "_italic text_"],
      [
        "converts strikethrough from double tilde to single",
        "~~strikethrough~~",
        "~strikethrough~",
      ],
      [
        "renders basic inline formatting together",
        "hi _there_ **boss** `code`",
        "hi _there_ *boss* `code`",
      ],
      ["renders inline code", "use `npm install`", "use `npm install`"],
      ["renders fenced code blocks", "```js\nconst x = 1;\n```", "```\nconst x = 1;\n```"],
      [
        "renders links with Slack mrkdwn syntax",
        "see [docs](https://example.com)",
        "see <https://example.com|docs>",
      ],
      ["does not duplicate bare URLs", "see https://example.com", "see https://example.com"],
      ["escapes unsafe characters", "a & b < c > d", "a &amp; b &lt; c &gt; d"],
      [
        "preserves Slack angle-bracket markup (mentions/links)",
        "hi <@U123> see <https://example.com|docs> and <!here>",
        "hi <@U123> see <https://example.com|docs> and <!here>",
      ],
      ["escapes raw HTML", "<b>nope</b>", "&lt;b&gt;nope&lt;/b&gt;"],
      ["renders paragraphs with blank lines", "first\n\nsecond", "first\n\nsecond"],
      ["renders bullet lists", "- one\n- two", "• one\n• two"],
      ["renders ordered lists with numbering", "2. two\n3. three", "2. two\n3. three"],
      ["renders headings as bold text", "# Title", "*Title*"],
      ["renders blockquotes", "> Quote", "> Quote"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(markdownToSlackMrkdwn(input), name).toBe(expected);
    }
  });

  it("handles nested list items", () => {
    const res = markdownToSlackMrkdwn("- item\n  - nested");
    // markdown-it correctly parses this as a nested list
    expect(res).toBe("• item\n  • nested");
  });

  it("handles complex message with multiple elements", () => {
    const res = markdownToSlackMrkdwn(
      "**Important:** Check the _docs_ at [link](https://example.com)\n\n- first\n- second",
    );
    expect(res).toBe(
      "*Important:* Check the _docs_ at <https://example.com|link>\n\n• first\n• second",
    );
  });

  it("converts Markdown tables into Slack-safe bullets", () => {
    const res = markdownToSlackMrkdwn(
      [
        "| Item | Estimate |",
        "|---|---:|",
        "| 25% deposit | **£45,000** |",
        "| Legal/survey/mortgage costs | **£2,000–£4,000** |",
      ].join("\n"),
      { tableMode: "bullets" },
    );

    expect(res).toBe("• 25% deposit: *£45,000*\n• Legal/survey/mortgage costs: *£2,000–£4,000*");
    expect(res).not.toContain("|---|");
  });

  it("keeps code fences intact while converting surrounding markdown", () => {
    const res = markdownToSlackMrkdwn(
      "**before**\n\n```ts\nconst ok = true;\n```\n\n[docs](https://example.com)",
    );

    expect(res).toBe("*before*\n\n```\nconst ok = true;\n```\n<https://example.com|docs>");
  });

  it("converts the mortgage cash table sample to Slack mrkdwn", () => {
    const input = [
      "Realistically: **the £18k deposit is probably the problem.**",
      "",
      "| Item | Estimate |",
      "|---|---:|",
      "| 25% deposit | **£45,000** |",
      "| Additional-property stamp duty | **~£10,100** |",
      "| Legal/survey/mortgage costs | **£2,000–£4,000** |",
      "| **Total cash needed** | **~£57k–£59k** |",
    ].join("\n");

    const res = markdownToSlackMrkdwn(input, { tableMode: "bullets" });

    expect(res).toBe(
      [
        "Realistically: *the £18k deposit is probably the problem.*",
        "",
        "• 25% deposit: *£45,000*",
        "• Additional-property stamp duty: *~£10,100*",
        "• Legal/survey/mortgage costs: *£2,000–£4,000*",
        "• *Total cash needed*: *~£57k–£59k*",
      ].join("\n"),
    );
    expect(res).not.toContain("**");
    expect(res).not.toContain("|---|");
  });
});

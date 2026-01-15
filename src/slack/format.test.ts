import { describe, expect, it } from "vitest";

import { markdownToSlackMrkdwn } from "./format.js";

describe("markdownToSlackMrkdwn", () => {
  it("converts bold from double asterisks to single", () => {
    const res = markdownToSlackMrkdwn("**bold text**");
    expect(res).toBe("*bold text*");
  });

  it("preserves italic underscore format", () => {
    const res = markdownToSlackMrkdwn("_italic text_");
    expect(res).toBe("_italic text_");
  });

  it("converts strikethrough from double tilde to single", () => {
    const res = markdownToSlackMrkdwn("~~strikethrough~~");
    expect(res).toBe("~strikethrough~");
  });

  it("renders basic inline formatting together", () => {
    const res = markdownToSlackMrkdwn("hi _there_ **boss** `code`");
    expect(res).toBe("hi _there_ *boss* `code`");
  });

  it("renders inline code", () => {
    const res = markdownToSlackMrkdwn("use `npm install`");
    expect(res).toBe("use `npm install`");
  });

  it("renders fenced code blocks", () => {
    const res = markdownToSlackMrkdwn("```js\nconst x = 1;\n```");
    expect(res).toBe("```\nconst x = 1;\n```");
  });

  it("renders links with Slack mrkdwn syntax", () => {
    const res = markdownToSlackMrkdwn("see [docs](https://example.com)");
    expect(res).toBe("see <https://example.com|docs>");
  });

  it("does not duplicate bare URLs", () => {
    const res = markdownToSlackMrkdwn("see https://example.com");
    expect(res).toBe("see https://example.com");
  });

  it("escapes unsafe characters", () => {
    const res = markdownToSlackMrkdwn("a & b < c > d");
    expect(res).toBe("a &amp; b &lt; c &gt; d");
  });

  it("preserves Slack angle-bracket markup (mentions/links)", () => {
    const res = markdownToSlackMrkdwn("hi <@U123> see <https://example.com|docs> and <!here>");
    expect(res).toBe("hi <@U123> see <https://example.com|docs> and <!here>");
  });

  it("escapes raw HTML", () => {
    const res = markdownToSlackMrkdwn("<b>nope</b>");
    expect(res).toBe("&lt;b&gt;nope&lt;/b&gt;");
  });

  it("renders paragraphs with blank lines", () => {
    const res = markdownToSlackMrkdwn("first\n\nsecond");
    expect(res).toBe("first\n\nsecond");
  });

  it("renders bullet lists", () => {
    const res = markdownToSlackMrkdwn("- one\n- two");
    expect(res).toBe("• one\n• two");
  });

  it("renders ordered lists with numbering", () => {
    const res = markdownToSlackMrkdwn("2. two\n3. three");
    expect(res).toBe("2. two\n3. three");
  });

  it("renders headings as bold text", () => {
    const res = markdownToSlackMrkdwn("# Title");
    expect(res).toBe("*Title*");
  });

  it("renders blockquotes", () => {
    const res = markdownToSlackMrkdwn("> Quote");
    expect(res).toBe("> Quote");
  });

  it("handles adjacent list items", () => {
    const res = markdownToSlackMrkdwn("- item\n  - nested");
    // markdown-it treats indented items as continuation, not nesting
    expect(res).toBe("• item  • nested");
  });

  it("handles complex message with multiple elements", () => {
    const res = markdownToSlackMrkdwn(
      "**Important:** Check the _docs_ at [link](https://example.com)\n\n- first\n- second",
    );
    expect(res).toBe(
      "*Important:* Check the _docs_ at <https://example.com|link>\n\n• first\n• second",
    );
  });
});

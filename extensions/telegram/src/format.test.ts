import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml, splitTelegramHtmlChunks } from "./format.js";

describe("markdownToTelegramHtml", () => {
  it("handles core markdown-to-telegram conversions", () => {
    const cases = [
      [
        "renders basic inline formatting",
        "hi _there_ **boss** `code`",
        "hi <i>there</i> <b>boss</b> <code>code</code>",
      ],
      [
        "renders links as Telegram-safe HTML",
        "see [docs](https://example.com)",
        'see <a href="https://example.com">docs</a>',
      ],
      ["escapes raw HTML", "<b>nope</b>", "&lt;b&gt;nope&lt;/b&gt;"],
      ["escapes unsafe characters", "a & b < c", "a &amp; b &lt; c"],
      ["renders paragraphs with blank lines", "first\n\nsecond", "first\n\nsecond"],
      ["renders lists without block HTML", "- one\n- two", "• one\n• two"],
      ["renders ordered lists with numbering", "2. two\n3. three", "2. two\n3. three"],
      ["flattens headings", "# Title", "Title"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(markdownToTelegramHtml(input), name).toBe(expected);
    }
  });

  it("renders blockquotes as native Telegram blockquote tags", () => {
    const res = markdownToTelegramHtml("> Quote");
    expect(res).toContain("<blockquote>");
    expect(res).toContain("Quote");
    expect(res).toContain("</blockquote>");
  });

  it("renders blockquotes with inline formatting", () => {
    const res = markdownToTelegramHtml("> **bold** quote");
    expect(res).toContain("<blockquote>");
    expect(res).toContain("<b>bold</b>");
    expect(res).toContain("</blockquote>");
  });

  it("renders multiline blockquotes as a single Telegram blockquote", () => {
    const res = markdownToTelegramHtml("> first\n> second");
    expect(res).toBe("<blockquote>first\nsecond</blockquote>");
  });

  it("renders separated quoted paragraphs as distinct blockquotes", () => {
    const res = markdownToTelegramHtml("> first\n\n> second");
    expect(res).toContain("<blockquote>first");
    expect(res).toContain("<blockquote>second</blockquote>");
    expect(res.match(/<blockquote>/g)).toHaveLength(2);
  });

  it("renders fenced code blocks", () => {
    const res = markdownToTelegramHtml("```js\nconst x = 1;\n```");
    expect(res).toBe("<pre><code>const x = 1;\n</code></pre>");
  });

  it("properly nests overlapping bold and autolink (#4071)", () => {
    const res = markdownToTelegramHtml("**start https://example.com** end");
    expect(res).toMatch(
      /<b>start <a href="https:\/\/example\.com">https:\/\/example\.com<\/a><\/b> end/,
    );
  });

  it("properly nests link inside bold", () => {
    const res = markdownToTelegramHtml("**bold [link](https://example.com) text**");
    expect(res).toBe('<b>bold <a href="https://example.com">link</a> text</b>');
  });

  it("properly nests bold wrapping a link with trailing text", () => {
    const res = markdownToTelegramHtml("**[link](https://example.com) rest**");
    expect(res).toBe('<b><a href="https://example.com">link</a> rest</b>');
  });

  it("properly nests bold inside a link", () => {
    const res = markdownToTelegramHtml("[**bold**](https://example.com)");
    expect(res).toBe('<a href="https://example.com"><b>bold</b></a>');
  });

  it("wraps punctuated file references in code tags", () => {
    const res = markdownToTelegramHtml("See README.md. Also (backup.sh).");
    expect(res).toContain("<code>README.md</code>.");
    expect(res).toContain("(<code>backup.sh</code>).");
  });

  it("renders spoiler tags", () => {
    const res = markdownToTelegramHtml("the answer is ||42||");
    expect(res).toBe("the answer is <tg-spoiler>42</tg-spoiler>");
  });

  it("renders spoiler with nested formatting", () => {
    const res = markdownToTelegramHtml("||**secret** text||");
    expect(res).toBe("<tg-spoiler><b>secret</b> text</tg-spoiler>");
  });

  it("does not treat single pipe as spoiler", () => {
    const res = markdownToTelegramHtml("(￣_￣|) face");
    expect(res).not.toContain("tg-spoiler");
    expect(res).toContain("|");
  });

  it("does not treat unpaired || as spoiler", () => {
    const res = markdownToTelegramHtml("before || after");
    expect(res).not.toContain("tg-spoiler");
    expect(res).toContain("||");
  });

  it("keeps valid spoiler pairs when a trailing || is unmatched", () => {
    const res = markdownToTelegramHtml("||secret|| trailing ||");
    expect(res).toContain("<tg-spoiler>secret</tg-spoiler>");
    expect(res).toContain("trailing ||");
  });

  it("splits long multiline html text without breaking balanced tags", () => {
    const chunks = splitTelegramHtmlChunks(`<b>${"A\n".repeat(2500)}</b>`, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks[0]).toMatch(/^<b>[\s\S]*<\/b>$/);
    expect(chunks[1]).toMatch(/^<b>[\s\S]*<\/b>$/);
  });

  it("fails loudly when a leading entity cannot fit inside a chunk", () => {
    expect(() => splitTelegramHtmlChunks(`A&amp;${"B".repeat(20)}`, 4)).toThrow(/leading entity/i);
  });

  it("treats malformed leading ampersands as plain text when chunking html", () => {
    const chunks = splitTelegramHtmlChunks(`&${"A".repeat(5000)}`, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
  });

  it("fails loudly when tag overhead leaves no room for text", () => {
    expect(() => splitTelegramHtmlChunks("<b><i><u>x</u></i></b>", 10)).toThrow(/tag overhead/i);
  });
});
